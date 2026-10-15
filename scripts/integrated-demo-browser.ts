import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createBrowserDemoLab } from '../src/demo-browser-lab.js';
import { readFile } from 'node:fs/promises';
import { createDemoDashboard } from '../src/integrated-demo-dashboard.js';
import { parseRunReplay } from '../src/demo-run-replay.js';

export async function startDemoBrowser(root = process.cwd(), openBrowser = true, allowReminderRepair = false,
  createLab: typeof createBrowserDemoLab = createBrowserDemoLab) {
  const lab = await createLab(root, { allow_reminder_repair: allowReminderRepair });
  console.log('\nSTRATA PRIVATE DEMO LAB\nLeave this terminal open. Begin, decisions and cleanup are controlled in your browser.');
  console.log('Open in Chrome: ' + lab.url);
  console.log('No coding actor starts until you approve Begin demo. Costs remain unverified.');
  if (openBrowser && process.platform === 'win32') {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
      '$strataChrome = @("$env:ProgramFiles/Google/Chrome/Application/chrome.exe", "${env:ProgramFiles(x86)}/Google/Chrome/Application/chrome.exe", "$env:LOCALAPPDATA/Google/Chrome/Application/chrome.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1; if ($strataChrome) { Start-Process -FilePath $strataChrome -ArgumentList $env:STRATA_DEMO_BROWSER_URL } else { Start-Process -FilePath $env:STRATA_DEMO_BROWSER_URL }'],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, STRATA_DEMO_BROWSER_URL: lab.url } });
    child.on('error', () => console.log('Open the link above manually in Chrome.'));
  }
  let closing = false;
  const close = () => { if (closing) return; closing = true; console.log('Stopping safely. Keep this terminal open while cleanup settles.');
    void lab.close().finally(() => { process.off('SIGINT', close); process.off('SIGTERM', close); }); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
  lab.check();
  return { ...lab, async close() { process.off('SIGINT', close); process.off('SIGTERM', close); await lab.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--replay')) {
    const replay = parseRunReplay(JSON.parse(await readFile(path.join(process.cwd(), 'examples/replay/synthetic-run.json'), 'utf8')));
    const dashboard = await createDemoDashboard(replay.run_id, () => {}, undefined, { source_mode: 'recorded-replay', replay });
    console.log('STRATA SYNTHETIC EXAMPLE REPLAY — READ ONLY\nOpen the private loopback link: ' + dashboard.url);
    console.log('No readiness checks, credentials, actors, provider calls, grants or cleanup actions. Ctrl+C closes this preview.');
    const close = () => { process.off('SIGINT', close); process.off('SIGTERM', close); void dashboard.close(); };
    process.on('SIGINT', close); process.on('SIGTERM', close);
  } else {
    startDemoBrowser(process.cwd(), !process.argv.includes('--no-browser'), process.argv.includes('--allow-reminder-repair')).catch(error => { console.error(error.message); process.exitCode = 7; });
  }
}
