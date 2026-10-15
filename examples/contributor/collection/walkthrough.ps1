# PowerShell 7. Explicit public CLI operations; no engine/test helpers or hidden workflow endpoint.
param([Parameter(Mandatory)][string]$Project, [switch]$Readback,
  [ValidateRange(2,32)][int]$Capacity=5, [ValidateRange(2,32)][int]$AlternateCapacity=4,
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$ChangeLayerId='StarterLimit',
  [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$AlternateLayerId='StarterAlternative')
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$cli = Join-Path $repository 'dist/src/cli.js'
$Project = [IO.Path]::GetFullPath($Project)
$marker = Get-Content -LiteralPath (Join-Path $Project 'CONTRIBUTOR.json') -Raw | ConvertFrom-Json
if ($marker.format -ne 'strata-local-contributor/1' -or $marker.synthetic -ne $true -or $marker.project_id -ne 'contributor-collection') {
  throw 'This learning script requires the explicit disposable contributor setup.'
}
$sessions = Get-Content -LiteralPath (Join-Path $Project 'sessions.json') -Raw | ConvertFrom-Json
$oldSession = $env:STRATA_SESSION
$sequence = 0
function Save-Json([string]$File, $Value) {
  [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 100) + "`n", [Text.UTF8Encoding]::new($false))
}
function Call-Strata([string]$Role, [string[]]$Arguments, $Record = $null, [switch]$RetainBlockedComposition, [string]$ExpectedRefusal='') {
  $env:STRATA_SESSION = $sessions.sessions.$Role
  if (-not $env:STRATA_SESSION) { throw 'The explicitly assigned synthetic role session is absent. Restart the starter and reload sessions.' }
  $commandArguments = @($Arguments)
  $script:sequence++
  $receiptName = '{0:D3}-{1}' -f $script:sequence, $(if($Readback){'readback'}else{'create'})
  if ($null -ne $Record) {
    $file = Join-Path $Project ("receipts/$receiptName-input.json")
    Save-Json $file $Record
    $commandArguments += @('--file', $file)
  }
  $raw = & node $cli @commandArguments --project $Project --json --offline --non-interactive
  $exit = $LASTEXITCODE
  $envelope = $raw | ConvertFrom-Json
  Save-Json (Join-Path $Project ("receipts/$receiptName-cli.json")) $envelope
  if ($ExpectedRefusal) {
    if ($exit -eq 0 -or $envelope.ok -eq $true -or $envelope.errors[0].code -cne $ExpectedRefusal) { throw 'The exact expected refusal was not observed.' }
    Write-Host "Confirmed ordinary-operation refusal: $ExpectedRefusal."
    return $envelope
  }
  if ($RetainBlockedComposition -and $Arguments[0] -eq 'compose' -and $exit -eq 5 -and $envelope.data.state -eq 'blocked') {
    Write-Host 'Retained the blocked complete considered set. No effective winner or materialization is claimed.'
    return $envelope.data
  }
  if ($exit -ne 0 -or $envelope.ok -ne $true) {
    $envelope.errors | ConvertTo-Json -Depth 10 | Write-Host
    throw 'The ordinary CLI refused. Stop and inspect the retained receipt; no identity switch, automatic retry, evidence replacement or reset.'
  }
  return $envelope.data
}
function Decide([string]$Text) {
  Write-Host $Text
  if ((Read-Host 'Synthetic local decision: type ACCEPT to record it, anything else stops') -cne 'ACCEPT') {
    throw 'Stopped before submitting this decision. Existing records remain.'
  }
}
function Check-Behavior([string]$Output, [string]$Stage) {
  $literalCapacity = if ($Stage -eq 'baseline') { 3 } else { $Capacity }
  $raw = & node (Join-Path $PSScriptRoot 'observe.mjs') $Output $Stage $literalCapacity
  if ($LASTEXITCODE -ne 0) { throw 'Literal output observations failed. Do not review or approve this result.' }
  $observations = $raw | ConvertFrom-Json
  $observations | ConvertTo-Json | Write-Host
  return $observations
}
function Accept-Candidate($Target, [string]$Slot, [string]$Baseline) {
  $output = Call-Strata runner @('materialize', $Target.ref, '--profile', 'collection-host/1', '--out', $marker.slots.$Slot)
  $realization = (Get-Content -LiteralPath $output.manifest -Raw | ConvertFrom-Json).record
  $observations = Check-Behavior (Join-Path $Project $marker.slots.$Slot) $Slot
  $run = Call-Strata runner @('evidence', 'run') @{ target=$Target.ref; slot=$Slot; profile='collection-host/1' }
  if ($run.checks_passed -ne $true -or $run.review_pending -ne $true) { throw 'The measured run is incomplete. Passing mechanical checks cannot supply review.' }
  $reviewRefs = @()
  foreach ($criterion in @($realization.oracle.criteria | Where-Object method -eq 'review')) {
    $criterion | ConvertTo-Json -Depth 30 | Write-Host
    Decide 'Reviewer: inspect this exact criterion, the intent and the selected generated output. This local account attestation is not independent human evidence.'
    $review = Call-Strata reviewer @('criterion', 'review') @{ realization=$output.ref; criterion=$criterion; accepted=$true; rationale='Attended synthetic contributor reviewed this exact finite collection criterion.' }
    $reviewRefs += $review.ref
  }
  $assembly = Call-Strata runner @('evidence', 'assemble') @{ realization=$output.ref; run_ref=$run.ref; review_refs=$reviewRefs }
  # Validation checks measured evidence and the current output bytes; it does not run the tests.
  $evidenceFile = Join-Path $Project 'receipts/current-evidence.json'; Save-Json $evidenceFile $assembly.evidence
  $validation = Call-Strata runner @('validate', $Target.ref, '--realization', $output.manifest, '--evidence', $evidenceFile)
  $state = Call-Strata reader @('review', 'state', $Target.ref)
  $generation = (Call-Strata reader @('capabilities')).mediation_generation
  $shape = @{ format='approval/3'; project_id=$marker.project_id; model_version=$marker.model_version; baseline=$Baseline;
    authority_sha256=$state.authority_sha256; target=$Target.fingerprint; evidence_digest=$validation.evidence_digest;
    generation=$generation; expires_at=$null; binding=$null }
  $state | ConvertTo-Json -Depth 40 | Write-Host
  Decide 'Scope selector: approve this exact collection candidate, baseline authority and validated evidence digest.'
  $scopeInput = $shape.Clone(); $scopeInput.kind='scope'; $scopeInput.scope='collection'
  $scope = Call-Strata scope-selector @('approve') $scopeInput
  Decide 'Release manager: separately approve publication of this exact validated candidate. Release is not deployment.'
  $releaseInput = $shape.Clone(); $releaseInput.kind='release'; $releaseInput.scope=$null
  $approval = Call-Strata release-manager @('approve') $releaseInput
  $released = Call-Strata release-manager @('release', $Target.ref, '--validation', $validation.ref, '--approval', $scope.ref, '--approval', $approval.ref)
  $record = Call-Strata reader @('inspect', 'release', $released.ref)
  return @{ release=$released.ref; record=$record; target=$Target.ref; realization=$output.ref; output_tree=$realization.output_tree;
    run=$run.ref; validation=$validation.ref; reviews=$reviewRefs; approvals=@($scope.ref,$approval.ref); observations=$observations }
}
try {
  Write-Host 'SYNTHETIC LOCAL DEVELOPMENT: one user controls all roles. No providers, hosted owner setup or independent human identity.'
  $config = Call-Strata reader @('config', 'show')
  if ($config.model_version -ne $marker.model_version -or $config.project_id -ne $marker.project_id -or $config.network_policy -ne 'loopback-only') { throw 'Unexpected project configuration.' }
  Call-Strata reader @('capabilities') | ConvertTo-Json -Depth 20 | Write-Host
  $resultFile = Join-Path $Project 'receipts/walkthrough-result.json'
  if ($Readback) {
    $saved = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
    $Capacity = $saved.changed.observations.capacity
    $record = Call-Strata reader @('inspect', 'release', $saved.changed.release)
    if (($record | ConvertTo-Json -Depth 100 -Compress) -cne ($saved.changed.record | ConvertTo-Json -Depth 100 -Compress)) { throw 'Exact retained Release changed.' }
    $output = Call-Strata runner @('materialize', $saved.changed.release, '--profile', 'collection-host/1', '--out', $marker.slots.independent)
    $realization = (Get-Content -LiteralPath $output.manifest -Raw | ConvertFrom-Json).record
    if ($realization.output_tree -ne $saved.changed.output_tree) { throw 'Independent output differs.' }
    $observations = Check-Behavior (Join-Path $Project $marker.slots.independent) changed
    Save-Json (Join-Path $Project 'receipts/readback-result.json') @{ exact_release=$saved.changed.release; output_tree=$realization.output_tree; observations=$observations }
    Write-Host 'Exact Release read back and independently rematerialized after restart; no Layers replayed or new approvals submitted.'
  } else {
    if ($Capacity -eq 3 -or $AlternateCapacity -eq 3 -or $Capacity -eq $AlternateCapacity -or $ChangeLayerId -eq $AlternateLayerId -or $ChangeLayerId -in @('StarterAudit','StarterDecision') -or $AlternateLayerId -in @('StarterAudit','StarterDecision')) { throw 'Choose distinct fresh capacity proposals and Layer IDs, different from the baseline/reserved IDs.' }
    if (Test-Path -LiteralPath $resultFile) { throw 'This project already has walkthrough results. Use -Readback after restart, or prepare a different new folder.' }
    $seedInput = Get-Content -LiteralPath (Join-Path $Project 'inputs/bootstrap.json') -Raw | ConvertFrom-Json
    $seed = Call-Strata author-a @('init') $seedInput
    $recipe = Get-Content -LiteralPath (Join-Path $Project 'inputs/baseline-composition.json') -Raw | ConvertFrom-Json
    $recipe.baseline=$seed.ref
    $target = Call-Strata author-a @('compose') $recipe
    $baseline = Accept-Candidate $target baseline $seed.ref
    $proposals = @()
    foreach ($name in @('create-audit','change-limit','alternative-limit')) {
      $layer = Get-Content -LiteralPath (Join-Path $Project "inputs/$name.json") -Raw | ConvertFrom-Json
      $layer.baseline=$baseline.release
      $role = $layer.owner
      if ($name -ne 'create-audit') {
        $newCapacity = if($name -eq 'change-limit'){$Capacity}else{$AlternateCapacity}
        $layer.id = if($name -eq 'change-limit'){$ChangeLayerId}else{$AlternateLayerId}
        $layer.intent = "Propose a supported collection capacity of $newCapacity."
        $layer.changes[0].value.statement="At most $newCapacity items exist per collection instance."
        $layer.changes[0].value.parameters.max_items=$newCapacity
      }
      $preview = Call-Strata $role @('layer', 'preview') $layer
      $draft = Call-Strata $role @('layer', 'create') $layer
      $normalized = Call-Strata $role @('inspect', 'layer', $draft.ref)
      $normalized | ConvertTo-Json -Depth 100 | Write-Host
      Write-Host "Exact proposed content digest: $($preview.record_sha256)"
      Decide 'Authoring reviewer: inspect this complete normalized proposal and its pinned baseline. Creation requires a collection-parent assignment; capacity changes must retain acceptance.'
      # The author explicitly supplies normalized content; private-draft browsing is not granted to the reviewer.
      $review = Call-Strata reviewer @('content', 'review') @{ draft=$normalized; expected_digest=$preview.record_sha256; accepted=$true; rationale='Attended synthetic reviewer inspected this exact proposed content and baseline.' }
      Call-Strata $role @('layer', 'publish', $draft.ref, '--authoring-review', $review.ref) | Out-Null
      $proposals += $draft.ref
    }
    $recipe = Get-Content -LiteralPath (Join-Path $Project 'inputs/changed-composition.json') -Raw | ConvertFrom-Json
    $recipe.baseline=$baseline.release; $recipe.proposals=$proposals; $recipe.selected=$proposals
    $collision = Call-Strata author-a @('compose') $recipe -RetainBlockedComposition
    if ($collision.state -ne 'blocked') { throw 'Expected the complete competing set to be blocked.' }
    Call-Strata runner @('materialize',$collision.ref,'--profile','collection-host/1','--out',$marker.slots.independent) -ExpectedRefusal BLOCKED_CANDIDATE | Out-Null
    $selected=@($proposals[0],$proposals[1]);$rejected=@($proposals[2])
    $basis=Call-Strata author-a @('mediation','prepare') @{ target=$collision.ref; case_id='starter-capacity'; case_revision=1;
      expires_at=[DateTime]::UtcNow.AddMinutes(10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');goal='Choose an existing complete capacity proposal while retaining the audit Block and the losing proposal.';
      partitions=@(@{id='chosen-capacity';selected=$selected;rejected=$rejected});supersedes=$null }
    $decision=@{id='StarterDecision';revision=1;owner='author-a';model_version=$marker.model_version;baseline=$baseline.release;
      intent='Select the complete reviewed capacity proposal and audit Block.';created_blocks=@();changes=@();acceptance=@();requires_layers=@();read_set=@();assumptions=@();resolution_proposals=@($basis.decision_proposals[0].payload);derived_from=$null }
    $decisionDraft=Call-Strata author-a @('layer','create') $decision
    Call-Strata author-a @('layer','publish',$decisionDraft.ref) | Out-Null
    $packet=Call-Strata author-a @('mediation','prepare') @{basis_ref=$basis.ref;decisions=@(@{option_id='chosen-capacity';layer=$decisionDraft.ref;proposal_index=0})}
    $packet | ConvertTo-Json -Depth 100 | Write-Host
    Decide 'Responsible selector: inspect both owners and the complete selected/rejected partition in this exact packet. This selection is separate from later scope and Release approvals.'
    $selection=Call-Strata scope-selector @('mediation','respond') @{packet_ref=$packet.ref;packet_sha256=$packet.packet_sha256;case_revision=1;action='approve_selection';option_id='chosen-capacity';message='Attended synthetic selector chose the exact whole-Layer partition.'}
    $sealed=Call-Strata author-a @('resolve') @{layer=$decisionDraft.ref;proposal_index=0;composition=$collision.ref;approvals=@($selection.ref)}
    $recipe.revision++;$recipe.selected=$selected;$recipe.resolutions=@($sealed.ref)
    $changed = Accept-Candidate (Call-Strata author-a @('compose') $recipe) changed $baseline.release
    $changed.mediation=@{collision=$collision.ref;considered=$proposals;selected=$selected;rejected=$rejected;basis=$basis.ref;packet=$packet.ref;decision=$decisionDraft.ref;selection=$selection.ref;resolution=$sealed.ref}
    Save-Json $resultFile @{ format='strata-contributor-walkthrough/1'; synthetic=$true; baseline=$baseline; changed=$changed }
    Write-Host "Accepted baseline: $($baseline.release); resolved audited $Capacity-item Release: $($changed.release). Exact inputs/envelopes retained under receipts."
    Write-Host 'Stop/restart the starter in its terminal, then run this script with -Readback. Do not prepare/reset this folder.'
  }
} finally { $env:STRATA_SESSION=$oldSession }
