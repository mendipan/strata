// Describe only the attempted operation, never inferred grants.
export function namespaceFailure(error,action){
  const permission=action==='create'?'Artifacts Edit':'Artifacts Read';
  const messages={
    INVALID_REPOSITORY_NAME:'Use letters, numbers, hyphens or underscores for the repository name, with no spaces.',
    CREATION_CHANGED:'The repository changed since it was checked. Check unfinished setup again. Existing content is preserved.',
    REPOSITORY_NOT_FOUND:'The repository was not found. Refresh repositories before trying again.',
    SOURCE_AUTH:`The saved token was not accepted for this operation. Check ${permission} and the displayed Cloudflare account, token expiry and any IP restrictions. Replace the token below, then explicitly retry.`,
    NAMESPACE_NOT_FOUND:'The configured Artifacts namespace was not found. Check the displayed account and namespace with the installation owner. This page cannot create or change the approved namespace.',
    NAMESPACE_RATE_LIMIT:'Cloudflare limited this request. Wait before explicitly retrying. Reserved usage is retained.',
    NAMESPACE_PROVIDER_UNAVAILABLE:'Cloudflare could not be reached or its response could not be verified. Check the saved outcome, then explicitly retry a read. An uncertain creation needs reconciliation before another creation.',
    STALE_GENERATION:'Connection status changed. Refresh status before trying again.',
    ACCESS_REVOKED:'Namespace access is paused, unapproved or revoked. Refresh status and complete the displayed consent or resume step.',
    WORKSPACE_BUDGET_EXHAUSTED:'The approved usage allowance is exhausted. The installation owner must review further allowance; retrying or signing in cannot reset spending.',
    WRITER_IMPORT_REQUIRED:'Choose Open in the repository selector, then import its saved Strata project index. The index identifies the exact existing records.',
    REPOSITORY_ID_MISMATCH:'The repository identity changed or Cloudflare marks it read only. Refresh the list and check the repository settings before opening it.',
    IMPORT_FILE_UNAVAILABLE:'A record in the project index is unavailable. Choose the current Strata index for this repository; the remote data has not been changed.'
  };
  return messages[error.code]??error.message??'The action failed. Refresh status and inspect its saved outcome.';
}
