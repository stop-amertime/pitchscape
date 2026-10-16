// rustfft (MIT / Apache-2.0) as a small WebAssembly module for src/pipeline: complex f64 FFTs of any length (MOSQITO's
// roughness needs 9600 points, which fft.js, a power-of-two FFT, cannot do). Built by tools/fft64/build.sh into
// src/pipeline/vendor/fft64.wasm; src/pipeline/vendor/fft64.mjs loads it.
//
// alloc(n) -> a buffer of n complex numbers (re, im interleaved f64) in the module's memory.
// fft(ptr, n, inverse) transforms it in place, unnormalised (as rustfft and numpy's forward fft: the inverse is not
// divided by n). Plans and scratch are kept per length and direction.
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

thread_local! {
    static PLANNER: RefCell<FftPlanner<f64>> = RefCell::new(FftPlanner::new());
    static PLANS: RefCell<HashMap<(usize, bool), Arc<dyn Fft<f64>>>> = RefCell::new(HashMap::new());
    static SCRATCH: RefCell<Vec<Complex<f64>>> = RefCell::new(Vec::new());
}

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut f64 {
    let mut v = vec![Complex::new(0.0f64, 0.0); n];
    let p = v.as_mut_ptr() as *mut f64;
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn fft(ptr: *mut f64, n: usize, inverse: u32) {
    let inv = inverse != 0;
    let plan = PLANS.with(|p| {
        p.borrow_mut()
            .entry((n, inv))
            .or_insert_with(|| {
                PLANNER.with(|pl| {
                    let mut pl = pl.borrow_mut();
                    if inv { pl.plan_fft_inverse(n) } else { pl.plan_fft_forward(n) }
                })
            })
            .clone()
    });
    let buf = unsafe { std::slice::from_raw_parts_mut(ptr as *mut Complex<f64>, n) };
    SCRATCH.with(|s| {
        let mut s = s.borrow_mut();
        let need = plan.get_inplace_scratch_len();
        if s.len() < need {
            s.resize(need, Complex::new(0.0, 0.0));
        }
        plan.process_with_scratch(buf, &mut s[..need]);
    });
}
