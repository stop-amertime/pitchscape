#!/bin/sh
# Builds src/pipeline/vendor/fft64.wasm from rustfft (needs Rust with the wasm32-unknown-unknown target).
set -e
cd "$(dirname "$0")"
RUSTFLAGS="-C target-feature=+simd128" cargo +stable-x86_64-pc-windows-gnu build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/fft64.wasm ../../src/pipeline/vendor/fft64.wasm
