// A transition's length, or none when the person has asked their device for less motion.
const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const motion = ms => (reduce ? 0 : ms);
