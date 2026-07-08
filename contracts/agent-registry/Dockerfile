# Builds agent-registry.wasm with only Docker installed — no local Rust needed.
# The toolchain is pinned by rust-toolchain.toml; rustup installs it here.
#
#   docker build -f contracts/agent-registry/Dockerfile \
#     -o contracts/agent-registry contracts/agent-registry
#
# The wasm lands at contracts/agent-registry/agent-registry.wasm, ready for
# install.mjs / casper-client.

FROM rust:1.84-slim-bookworm AS build
WORKDIR /contract
COPY . .
RUN rustup show \
 && cargo build --release --target wasm32-unknown-unknown --locked \
 && cp target/wasm32-unknown-unknown/release/agent-registry.wasm /agent-registry.wasm

# Export stage: `-o <dir>` copies just the wasm out to the host.
FROM scratch AS export
COPY --from=build /agent-registry.wasm /agent-registry.wasm
