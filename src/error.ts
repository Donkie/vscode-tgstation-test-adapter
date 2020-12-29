
/**
 * Represents an error where the user has done something wrong, and should be notified of it in a nice way.
 */
export class UserError extends Error {
    constructor(m: string) {
        super(m);

        // Set the prototype explicitly.
        Object.setPrototypeOf(this, UserError.prototype);
    }
}

/**
 * Represents an error caused by misconfiguration.
 */
export class ConfigError extends Error {
    constructor(m: string) {
        super(m);

        // Set the prototype explicitly.
        Object.setPrototypeOf(this, ConfigError.prototype);
    }
}

/**
 * Represents an error caused by the user canceling an action.
 */
export class CancelError extends Error {
    constructor() {
        super("Canceled");

        // Set the prototype explicitly.
        Object.setPrototypeOf(this, CancelError.prototype);
    }
}

/**
 * Represents a general error caused during a test run
 */
export class RunError extends Error {
    constructor(m: string) {
        super(m);

        // Set the prototype explicitly.
        Object.setPrototypeOf(this, RunError.prototype);
    }
}
