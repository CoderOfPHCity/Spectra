#![no_std]
#![no_main]

use casper_contract::{
    contract_api::{runtime, storage},
    unwrap_or_revert::UnwrapOrRevert,
};
use casper_types::{
    account::AccountHash, ApiError, Key, RuntimeArgs, U512,
};

const ARG_AGENT: &str = "agent";
const ARG_STAKE: &str = "stake";
const ARG_SUCCESS: &str = "success";
const ARG_FEE: &str = "fee";

#[repr(u16)]
enum Error {
    AgentAlreadyExists = 1,
    AgentNotFound = 2,
    NotOwner = 3,
}

// Store a tuple (stake, total, success, fees) serialized as bytes under a key derived from agent account hash.

fn get_agent_key(agent: &AccountHash) -> Key {
    Key::Account(agent.to_account_hash())
}

#[no_mangle]
pub extern "C" fn register_agent() {
    let agent: AccountHash = runtime::get_named_arg(ARG_AGENT);
    let stake: U512 = runtime::get_named_arg(ARG_STAKE);

    let caller = runtime::get_caller();
    if caller != agent.into() {
        runtime::revert(ApiError::User(Error::NotOwner as u16));
    }

    let key = get_agent_key(&agent);
    if storage::read(&key).is_some() {
        runtime::revert(ApiError::User(Error::AgentAlreadyExists as u16));
    }

    let data = (stake, 0u64, 0u64, U512::zero());
    storage::write(&key, data);
}

#[no_mangle]
pub extern "C" fn report_trade() {
    let agent: AccountHash = runtime::get_named_arg(ARG_AGENT);
    let success: bool = runtime::get_named_arg(ARG_SUCCESS);
    let fee: U512 = runtime::get_named_arg(ARG_FEE);

    let key = get_agent_key(&agent);
    let mut data: (U512, u64, u64, U512) = storage::read(&key)
        .unwrap_or_revert()
        .unwrap_or_revert();

    data.1 += 1; // total_trades
    if success {
        data.2 += 1; // successful_trades
    }
    data.3 += fee; // fees_earned

    storage::write(&key, data);
}

#[no_mangle]
pub extern "C" fn slash_agent() {
    let agent: AccountHash = runtime::get_named_arg(ARG_AGENT);
    let key = get_agent_key(&agent);
    let mut data: (U512, u64, u64, U512) = storage::read(&key)
        .unwrap_or_revert()
        .unwrap_or_revert();

    // Slash 50% of stake
    data.0 = data.0 / U512::from(2);
    storage::write(&key, data);
}

#[no_mangle]
pub extern "C" fn get_agent() {
    let agent: AccountHash = runtime::get_named_arg(ARG_AGENT);
    let key = get_agent_key(&agent);
    let data: (U512, u64, u64, U512) = storage::read(&key)
        .unwrap_or_revert()
        .unwrap_or_revert();

    let result = format!(
        "{{\"stake\":\"{}\",\"total\":{},\"success\":{},\"fees\":\"{}\"}}",
        data.0, data.1, data.2, data.3
    );
    runtime::ret(Key::from(result.as_bytes()));
}