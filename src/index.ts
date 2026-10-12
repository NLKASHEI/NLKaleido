export { parseContract } from './core/contract.js';
export type { Contract, FieldRule, FieldType } from './core/contract.js';
export { initialSnapshot, readSnapshot, getValue, applyValues } from './core/state.js';
export type { Snapshot } from './core/state.js';
export { createVariableController } from './runtime/controller.js';
export type { SnapshotStorage, SetResult, VariableDescriptor } from './runtime/controller.js';
export { EXPERIMENTAL_METADATA_KEY, createStStorage, createStVariableBridge } from './runtime/st.js';

export { tokenizeEvidence, BM25FIndex } from './update/bm25f.js';
export type { EvidenceDocument, EvidenceHit, BM25FOptions } from './update/bm25f.js';
export { buildVariableUpdatePlan } from './update/scheduler.js';
export type { UpdateFieldPolicy, ScheduledGroup, ScheduledUpdatePlan } from './update/scheduler.js';
export { prepareVariableObservation, validateVariableDecisions, runVariableUpdateCycle } from './update/pipeline.js';
export type { FieldDecision, UpdateObservation, UpdateCommit, UpdateCycleInput, UpdateCycleResult } from './update/pipeline.js';
