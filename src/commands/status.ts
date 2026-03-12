/**
 * `cavendish status` — alias for `cavendish doctor`.
 * Re-exports the doctor command directly so args and behavior stay in sync.
 */
export { doctorCommand as statusCommand } from './doctor.js';
