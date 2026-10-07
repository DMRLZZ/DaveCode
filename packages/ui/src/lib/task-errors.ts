import { errorMessage, isApiError } from './api';

/** Plain-language explanation of a refused task or route write. */
export function writeErrorMessage(e: unknown): string {
  if (!isApiError(e)) return errorMessage(e);
  switch (e.code) {
    case 'brain_read_only':
      return 'This gateway exposes the project brain read-only, so the task graph cannot be edited here.';
    case 'no_brain':
      return 'No project is loaded. Start the gateway inside an initialised project (davecode init).';
    case 'cycle':
      return e.cycle ? `That would create a dependency cycle: ${e.cycle.join(' → ')}.` : e.message;
    case 'has_dependents':
      return e.dependents?.length
        ? `Other tasks still depend on it: ${e.dependents.join(', ')}. Remove those dependencies first.`
        : e.message;
    case 'task_in_progress':
      return 'The task is in progress. Reopen it before deleting it.';
    case 'duplicate_id':
      return 'A task with this id already exists.';
    case 'invalid_transition':
      return `The task cannot move to that status from its current one. ${e.message}`;
    case 'config_invalid':
      return `The global config file is not valid, so it was left untouched. ${e.message}`;
    default:
      return errorMessage(e);
  }
}
