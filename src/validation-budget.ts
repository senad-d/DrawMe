export interface ValidationBudget {
  work(units?: number): void;
  diagnostic(): void;
}

export class ValidationBudgetExceeded extends Error {
  constructor(readonly kind: "work" | "diagnostics") {
    super(`validation ${kind} budget exceeded`);
    this.name = "ValidationBudgetExceeded";
  }
}

function checkCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
}

/** Reserve capacity before doing work or retaining a diagnostic. Share across a validation. */
export function createValidationBudget(maxWork: number, maxDiagnostics: number): ValidationBudget {
  checkCount(maxWork, "validation work limit");
  checkCount(maxDiagnostics, "validation diagnostic limit");
  let workLeft = maxWork;
  let diagnosticsLeft = maxDiagnostics;
  return {
    work(units = 1) {
      checkCount(units, "validation work charge");
      if (units > workLeft) throw new ValidationBudgetExceeded("work");
      workLeft -= units;
    },
    diagnostic() {
      if (diagnosticsLeft === 0) throw new ValidationBudgetExceeded("diagnostics");
      diagnosticsLeft--;
    },
  };
}
