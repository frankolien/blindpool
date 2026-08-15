// Blindpool — Cairo workspace.
//
// `echo` is the starter kit's StrkInvokeHelper, kept verbatim as the one *working*
// reference for `privacy_invoke` against the live pool. Read it before writing
// `blindpool`: it shows the pool-as-caller assertion, the phase ordering (the pool sends
// tokens before invoke runs), the approve-back that lets the pool fill an open note, and
// the exact OpenNoteDeposit return shape.
//
// `blindpool` is the contract this project ships. It is a stub — see spec/CONTRACTS.md.

pub mod echo;
pub mod interfaces;
pub mod blindpool;
