import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { resolve } from 'node:path';

/** Test-only Swift admission probe. Product clients never send malformed requests. */
export async function runMalformedNativeRequest(provider: SubprocessRuntime, root: string, fault: string) {
  const launchId = 'launch_fixture';
  let request: Record<string, unknown> = { protocolVersion: 1, requestId: 'request_fixture', command: 'health', launchId };
  if (fault === 'unknown_command') request.command = 'script';
  if (fault === 'wrong_version') request.protocolVersion = 2;
  if (fault === 'extra_field') request.secret = 'private-fixture-value';
  if (fault === 'wrong_launch') request.launchId = 'wrong_launch';
  if (fault === 'boolean_version') request.protocolVersion = true;
  if (fault === 'invalid_id') request.requestId = '../private-fixture-value';
  if (fault.startsWith('observe_')) {
    request = { protocolVersion: 1, requestId: 'request_fixture', launchId, command: 'observe_fixture',
      target: { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' } };
    const target = request.target as Record<string, unknown>;
    if (fault === 'observe_extra') target.script = 'private-fixture-value';
    if (fault === 'observe_bool_pid') target.pid = true;
    if (fault === 'observe_missing_window') delete target.windowInstance;
    if (fault === 'observe_bool_window') target.windowId = true;
    if (fault === 'observe_negative_window') target.windowId = -1;
    if (fault === 'observe_invalid_instance') target.windowInstance = '../private-fixture-value';
  }
  if (fault.startsWith('revalidate_')) {
    request = { protocolVersion: 1, requestId: 'request_fixture', launchId, command: 'revalidate_fixture',
      target: { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
      element: { identifier: 'fixture.text', instance: 'element_fixture', operation: 'set_value' } };
    const target = request.target as Record<string, unknown>; const element = request.element as Record<string, unknown>;
    if (fault === 'revalidate_extra') element.script = 'private-fixture-value';
    if (fault === 'revalidate_bool_window') target.windowId = true;
    if (fault === 'revalidate_secure') element.identifier = 'fixture.secure';
    if (fault === 'revalidate_selector') element.identifier = 'arbitrary.selector';
    if (fault === 'revalidate_missing_instance') delete element.instance;
    if (fault === 'revalidate_bad_operation') element.operation = 'script';
  }
  if (fault.startsWith('act_')) {
    request = { protocolVersion: 1, requestId: 'request_fixture', launchId, command: 'act_fixture',
      target: { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
      element: { identifier: 'fixture.text', instance: 'element_fixture', operation: 'set_value' }, value: 'private-fixture-value' };
    const element = request.element as Record<string, unknown>;
    if (fault === 'act_extra') request.script = 'private-fixture-value';
    if (fault === 'act_press_value') element.operation = 'press';
    if (fault === 'act_set_missing_value') delete request.value;
    if (fault === 'act_secure') element.identifier = 'fixture.secure';
  }
  let raw = `${JSON.stringify(request, fault.startsWith('revalidate_') || fault.startsWith('act_') ? (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) : value : undefined)}\n`;
  if (fault === 'revalidate_duplicate_command') raw = raw.replace('"command":"revalidate_fixture"', '"command":"revalidate_fixture","command":"revalidate_fixture"');
  if (fault === 'revalidate_duplicate_instance') raw = raw.replace('"instance":"element_fixture"', '"instance":"element_fixture","instance":"element_fixture"');
  if (fault === 'act_duplicate_value') raw = raw.replace('"value":"private-fixture-value"', '"value":"private-fixture-value","value":"private-fixture-value"');
  if (fault === 'oversized') raw = `${'x'.repeat(8193)}\n`;
  if (fault === 'invalid_json') raw = 'private-fixture-value\n';
  if (fault === 'extra_frame') raw += `${JSON.stringify(request)}\n`;
  if (fault === 'truncated') raw = JSON.stringify(request);
  const handle = provider.spawn({
    argv: [resolve(root, 'dist/native/CUHelper'), '--managed-stdio'], cwd: root,
    stdio: { stdin: { data: raw }, stdout: { maxBytes: 8192 }, stderr: { maxBytes: 256 }, control: 'pipe' },
    graceMs: 100, signal: AbortSignal.timeout(2000),
  });
  handle.control?.on('error', () => {});
  handle.control?.end(`${launchId}\n`);
  const result = await handle.done;
  await handle.waitForExit(AbortSignal.timeout(2000));
  return { exitCode: result.exitCode, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? '' };
}
