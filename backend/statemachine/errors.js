export class InvalidRowTransitionError extends Error {
  constructor(rowId, attemptedAction) {
    super(`Row ${rowId}: cannot ${attemptedAction} -- not in a valid current state, or already claimed by another worker`);
    this.name = 'InvalidRowTransitionError';
    this.rowId = rowId;
  }
}

export class InvalidRunTransitionError extends Error {
  constructor(runId, attemptedAction) {
    super(`Run ${runId}: cannot ${attemptedAction} -- not in a valid current state`);
    this.name = 'InvalidRunTransitionError';
    this.runId = runId;
  }
}
