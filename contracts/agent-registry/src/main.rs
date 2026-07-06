//! AgentRegistry — Spectra
//!
//! A minimal, Casper-native take on ERC-8004 ("Trustless Agents"): an
//! on-chain registry that lets autonomous agents (like Spectra's
//! RoutingGuardAgent) register an identity, post a CSPR stake, and build
//! an auditable, on-chain reputation record (total jobs, success rate,
//! fees earned) that other agents or dApps can compete on and query.
//!
//! This intentionally does NOT implement full ERC-8004 / ERC-3643 —
//! there is no claims registry, no compliance layer, no delegated
//! attestation. It stores exactly what Spectra's decision doc calls for:
//! stake, success rate, and total fees, per agent, in a queryable
//! dictionary — enough for one agent's off-chain reputation math to have
//! a canonical on-chain anchor.
//!
//! ── Entry points ─────────────────────────────────────────────────────
//!   init()                                                  (internal, called once at install)
//!   register_agent(agent_id, stake_motes, source_purse)
//!   update_reputation(agent_id, success, fee_earned_motes)  (owner-only)
//!   deactivate_agent(agent_id)                               (owner-only)
//!   withdraw_stake(agent_id, target_purse)                   (owner-only, requires inactive)
//!   get_agent(agent_id) -> AgentRecord (CLType::Any)
//!   agent_count() -> u64
//!
//! ── Reading agent records off-chain ─────────────────────────────────
//! `get_agent` exists mainly so OTHER on-chain contracts can compose
//! with this registry via `call_contract`. For off-chain reads (e.g. the
//! Spectra dashboard or the RoutingGuardAgent itself), querying the
//! `agents` dictionary directly is far cheaper than sending a deploy:
//!
//!   casper-client get-dictionary-item <state-root-hash> \
//!     --contract-hash <agent-registry-contract-hash> \
//!     --dictionary-name agents \
//!     --dictionary-item-key <agent_id>
//!
//! or the equivalent CSPR.cloud REST / casper-js-sdk dictionary-item call
//! (see contracts/agent-registry/client/get-agent.mjs for a worked
//! example).
//!

#![no_std]
#![no_main]

extern crate alloc;

use alloc::{
    string::{String, ToString},
    vec,
    vec::Vec,
};

use casper_contract::{
    contract_api::{runtime, storage, system},
    unwrap_or_revert::UnwrapOrRevert,
};
use casper_types::{
    account::AccountHash,
    bytesrepr::{self, FromBytes, ToBytes},
    contracts::NamedKeys,
    CLType, CLTyped, CLValue, EntryPoint, EntryPointAccess, EntryPointType, EntryPoints, Key,
    Parameter, RuntimeArgs, URef, U512,
};

// ── Named-key / dictionary constants ─────────────────────────────────────────
const AGENTS_DICT: &str = "agents";
const AGENT_COUNT_KEY: &str = "agent_count";
const REGISTRY_PURSE_KEY: &str = "registry_purse";
const CONTRACT_HASH_KEY: &str = "agent_registry_contract_hash";
const CONTRACT_VERSION_KEY: &str = "agent_registry_contract_version";
const PACKAGE_HASH_KEY: &str = "agent_registry_package_hash";
const ACCESS_UREF_KEY: &str = "agent_registry_access_uref";

// ── Entry point names ─────────────────────────────────────────────────────────
const EP_INIT: &str = "init";
const EP_REGISTER_AGENT: &str = "register_agent";
const EP_UPDATE_REPUTATION: &str = "update_reputation";
const EP_DEACTIVATE_AGENT: &str = "deactivate_agent";
const EP_WITHDRAW_STAKE: &str = "withdraw_stake";
const EP_GET_AGENT: &str = "get_agent";
const EP_AGENT_COUNT: &str = "agent_count";

// ── Argument names ─────────────────────────────────────────────────────────────
const ARG_AGENT_ID: &str = "agent_id";
const ARG_STAKE_MOTES: &str = "stake_motes";
const ARG_SOURCE_PURSE: &str = "source_purse";
const ARG_SUCCESS: &str = "success";
const ARG_FEE_EARNED_MOTES: &str = "fee_earned_motes";
const ARG_TARGET_PURSE: &str = "target_purse";

// ── Errors ─────────────────────────────────────────────────────────────────────
#[repr(u16)]
enum Error {
    AlreadyInitialized = 1,
    AgentAlreadyRegistered = 2,
    AgentNotFound = 3,
    NotAgentOwner = 4,
    AgentStillActive = 5,
}

impl From<Error> for casper_types::ApiError {
    fn from(e: Error) -> Self {
        casper_types::ApiError::User(e as u16)
    }
}

// ── AgentRecord ────────────────────────────────────────────────────────────────
// Mirrors the "stake, success rate, total fees" fields called for in
// Spectra doc, plus enough bookkeeping (owner, timestamps,
// active flag) to make registration and withdrawal safe.
#[derive(Clone)]
pub struct AgentRecord {
    pub owner: AccountHash,
    pub stake_motes: U512,
    pub total_jobs: u64,
    pub successful_jobs: u64,
    pub total_fees_motes: U512,
    /// Basis points, 0-10_000 (successful_jobs / total_jobs * 10_000).
    /// This is the canonical, auditable on-chain score — distinct from
    /// (and allowed to diverge slightly from) the fast local EMA score
    /// the off-chain RoutingGuardAgent keeps for immediate display.
    pub reputation_score: u32,
    pub registered_at: u64,
    pub active: bool,
}

impl CLTyped for AgentRecord {
    fn cl_type() -> CLType {
        CLType::Any
    }
}

impl ToBytes for AgentRecord {
    fn to_bytes(&self) -> Result<Vec<u8>, bytesrepr::Error> {
        let mut result = bytesrepr::allocate_buffer(self)?;
        result.extend(self.owner.to_bytes()?);
        result.extend(self.stake_motes.to_bytes()?);
        result.extend(self.total_jobs.to_bytes()?);
        result.extend(self.successful_jobs.to_bytes()?);
        result.extend(self.total_fees_motes.to_bytes()?);
        result.extend(self.reputation_score.to_bytes()?);
        result.extend(self.registered_at.to_bytes()?);
        result.extend(self.active.to_bytes()?);
        Ok(result)
    }

    fn serialized_length(&self) -> usize {
        self.owner.serialized_length()
            + self.stake_motes.serialized_length()
            + self.total_jobs.serialized_length()
            + self.successful_jobs.serialized_length()
            + self.total_fees_motes.serialized_length()
            + self.reputation_score.serialized_length()
            + self.registered_at.serialized_length()
            + self.active.serialized_length()
    }
}

impl FromBytes for AgentRecord {
    fn from_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), bytesrepr::Error> {
        let (owner, rem) = AccountHash::from_bytes(bytes)?;
        let (stake_motes, rem) = U512::from_bytes(rem)?;
        let (total_jobs, rem) = u64::from_bytes(rem)?;
        let (successful_jobs, rem) = u64::from_bytes(rem)?;
        let (total_fees_motes, rem) = U512::from_bytes(rem)?;
        let (reputation_score, rem) = u32::from_bytes(rem)?;
        let (registered_at, rem) = u64::from_bytes(rem)?;
        let (active, rem) = bool::from_bytes(rem)?;
        Ok((
            AgentRecord {
                owner,
                stake_motes,
                total_jobs,
                successful_jobs,
                total_fees_motes,
                reputation_score,
                registered_at,
                active,
            },
            rem,
        ))
    }
}

// ── Named-key lookup helpers ───────────────────────────────────────────────────
fn agents_dict_uref() -> URef {
    runtime::get_key(AGENTS_DICT)
        .unwrap_or_revert()
        .into_uref()
        .unwrap_or_revert()
}

fn agent_count_uref() -> URef {
    runtime::get_key(AGENT_COUNT_KEY)
        .unwrap_or_revert()
        .into_uref()
        .unwrap_or_revert()
}

fn registry_purse_uref() -> URef {
    runtime::get_key(REGISTRY_PURSE_KEY)
        .unwrap_or_revert()
        .into_uref()
        .unwrap_or_revert()
}

fn read_agent(agents_uref: URef, agent_id: &str) -> AgentRecord {
    match storage::dictionary_get::<AgentRecord>(agents_uref, agent_id).unwrap_or_revert() {
        Some(record) => record,
        None => runtime::revert(Error::AgentNotFound),
    }
}

fn require_owner(record: &AgentRecord) {
    if runtime::get_caller() != record.owner {
        runtime::revert(Error::NotAgentOwner);
    }
}

// ── Entry points ───────────────────────────────────────────────────────────────

/// Runs once, immediately after contract creation (called by `call()`
/// via `call_contract`, so it executes inside the CONTRACT's own
/// context and can populate the contract's own named keys).
#[no_mangle]
pub extern "C" fn init() {
    if runtime::has_key(AGENTS_DICT) {
        runtime::revert(Error::AlreadyInitialized);
    }

    storage::new_dictionary(AGENTS_DICT).unwrap_or_revert();

    let count_uref = storage::new_uref(0u64);
    runtime::put_key(AGENT_COUNT_KEY, count_uref.into());

    let purse = system::create_purse();
    runtime::put_key(REGISTRY_PURSE_KEY, purse.into());
}

/// Registers the caller as the owner of a new agent_id, optionally
/// posting a CSPR stake (transferred from a purse URef the caller
/// supplies — typically obtained client-side via `account::get_main_purse`
/// in session code, then passed through as an argument).
#[no_mangle]
pub extern "C" fn register_agent() {
    let agent_id: String = runtime::get_named_arg(ARG_AGENT_ID);
    let stake_motes: U512 = runtime::get_named_arg(ARG_STAKE_MOTES);

    let agents_uref = agents_dict_uref();

    if storage::dictionary_get::<AgentRecord>(agents_uref, &agent_id)
        .unwrap_or_revert()
        .is_some()
    {
        runtime::revert(Error::AgentAlreadyRegistered);
    }

    if stake_motes > U512::zero() {
        let source_purse: URef = runtime::get_named_arg(ARG_SOURCE_PURSE);
        let registry_purse = registry_purse_uref();
        system::transfer_from_purse_to_purse(source_purse, registry_purse, stake_motes, None)
            .unwrap_or_revert();
    }

    let record = AgentRecord {
        owner: runtime::get_caller(),
        stake_motes,
        total_jobs: 0,
        successful_jobs: 0,
        total_fees_motes: U512::zero(),
        reputation_score: 0,
        registered_at: runtime::get_blocktime().into(),
        active: true,
    };

    storage::dictionary_put(agents_uref, &agent_id, record);

    let count_uref = agent_count_uref();
    let count: u64 = storage::read(count_uref).unwrap_or_revert().unwrap_or_default();
    storage::write(count_uref, count + 1);
}

/// Records the outcome of one job (a /route call, in Spectra's case).
/// Restricted to the agent's registered owner — this is what the
/// RoutingGuardAgent's operating key calls after every analyzeRoute().
#[no_mangle]
pub extern "C" fn update_reputation() {
    let agent_id: String = runtime::get_named_arg(ARG_AGENT_ID);
    let success: bool = runtime::get_named_arg(ARG_SUCCESS);
    let fee_earned_motes: U512 = runtime::get_named_arg(ARG_FEE_EARNED_MOTES);

    let agents_uref = agents_dict_uref();
    let mut record = read_agent(agents_uref, &agent_id);
    require_owner(&record);

    record.total_jobs += 1;
    if success {
        record.successful_jobs += 1;
    }
    record.total_fees_motes += fee_earned_motes;
    record.reputation_score =
        ((record.successful_jobs as u128 * 10_000) / record.total_jobs as u128) as u32;

    storage::dictionary_put(agents_uref, &agent_id, record);
}

/// Marks an agent inactive. Required before its stake can be withdrawn.
#[no_mangle]
pub extern "C" fn deactivate_agent() {
    let agent_id: String = runtime::get_named_arg(ARG_AGENT_ID);

    let agents_uref = agents_dict_uref();
    let mut record = read_agent(agents_uref, &agent_id);
    require_owner(&record);

    record.active = false;
    storage::dictionary_put(agents_uref, &agent_id, record);
}

/// Returns a deactivated agent's stake to a purse the owner supplies.
#[no_mangle]
pub extern "C" fn withdraw_stake() {
    let agent_id: String = runtime::get_named_arg(ARG_AGENT_ID);
    let target_purse: URef = runtime::get_named_arg(ARG_TARGET_PURSE);

    let agents_uref = agents_dict_uref();
    let mut record = read_agent(agents_uref, &agent_id);
    require_owner(&record);

    if record.active {
        runtime::revert(Error::AgentStillActive);
    }

    let amount = record.stake_motes;
    if amount > U512::zero() {
        let registry_purse = registry_purse_uref();
        system::transfer_from_purse_to_purse(registry_purse, target_purse, amount, None)
            .unwrap_or_revert();
        record.stake_motes = U512::zero();
        storage::dictionary_put(agents_uref, &agent_id, record);
    }
}

/// Composability getter for other on-chain contracts. Off-chain callers
/// should query the `agents` dictionary directly instead (see module
/// docs above) — it's a read, not a deploy.
#[no_mangle]
pub extern "C" fn get_agent() {
    let agent_id: String = runtime::get_named_arg(ARG_AGENT_ID);
    let agents_uref = agents_dict_uref();
    let record = read_agent(agents_uref, &agent_id);
    runtime::ret(CLValue::from_t(record).unwrap_or_revert());
}

#[no_mangle]
pub extern "C" fn agent_count() {
    let count_uref = agent_count_uref();
    let count: u64 = storage::read(count_uref).unwrap_or_revert().unwrap_or_default();
    runtime::ret(CLValue::from_t(count).unwrap_or_revert());
}

// ── Installer ──────────────────────────────────────────────────────────────────
fn build_entry_points() -> EntryPoints {
    let mut entry_points = EntryPoints::new();

    entry_points.add_entry_point(EntryPoint::new(
        EP_INIT,
        vec![],
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        EP_REGISTER_AGENT,
        vec![
            Parameter::new(ARG_AGENT_ID, CLType::String),
            Parameter::new(ARG_STAKE_MOTES, CLType::U512),
            Parameter::new(ARG_SOURCE_PURSE, CLType::URef),
        ],
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        EP_UPDATE_REPUTATION,
        vec![
            Parameter::new(ARG_AGENT_ID, CLType::String),
            Parameter::new(ARG_SUCCESS, CLType::Bool),
            Parameter::new(ARG_FEE_EARNED_MOTES, CLType::U512),
        ],
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        EP_DEACTIVATE_AGENT,
        vec![Parameter::new(ARG_AGENT_ID, CLType::String)],
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        EP_WITHDRAW_STAKE,
        vec![
            Parameter::new(ARG_AGENT_ID, CLType::String),
            Parameter::new(ARG_TARGET_PURSE, CLType::URef),
        ],
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        EP_GET_AGENT,
        vec![Parameter::new(ARG_AGENT_ID, CLType::String)],
        CLType::Any,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        EP_AGENT_COUNT,
        vec![],
        CLType::U64,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points
}

#[no_mangle]
pub extern "C" fn call() {
    let entry_points = build_entry_points();
    let named_keys = NamedKeys::new();

    let (contract_hash, contract_version) = storage::new_locked_contract(
        entry_points,
        Some(named_keys),
        Some(PACKAGE_HASH_KEY.to_string()),
        Some(ACCESS_UREF_KEY.to_string()),
    );

    runtime::put_key(CONTRACT_HASH_KEY, Key::from(contract_hash));
    runtime::put_key(CONTRACT_VERSION_KEY, storage::new_uref(contract_version).into());
    runtime::call_contract::<()>(contract_hash, EP_INIT, RuntimeArgs::new());
}
