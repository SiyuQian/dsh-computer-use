import { createReadStream } from 'node:fs';

// A test-only process. Product code never accepts a command or executable from the model.
const fault = process.argv[2];
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
if (fault === 'hang' || fault === 'hang_ready') {
  if (fault === 'hang_ready') process.stdout.write('TEST_HELPER_READY\n');
  setInterval(() => {}, 1000);
} else if (fault === 'crash') {
  process.stderr.write('private-fixture-value');
  process.exitCode = 7;

} else {
  const request = JSON.parse(raw);
  let response = {
    protocolVersion: 1, requestId: request.requestId, launchId: request.launchId,
    status: 'ok', commands: ['health', 'observe_fixture', 'revalidate_fixture'], helperPid: process.pid,
    capabilities: { axObservation: false, mutation: false, keyboard: false, pointer: false },
    permissions: { accessibility: false, screenCapture: false },
  };
  if (fault.startsWith('revalidate_')) {
    response = { protocolVersion: 1, requestId: request.requestId, launchId: request.launchId, status: 'exact', dispatchable: false, target: request.target, element: request.element };
    if (fault === 'revalidate_wrong_target') response.target.windowInstance = 'window_another';
    if (fault === 'revalidate_wrong_instance') response.element.instance = 'element_another';
    if (fault === 'revalidate_wrong_operation') response.element.operation = 'press';
    if (fault === 'revalidate_dispatchable') response.dispatchable = true;
    if (fault === 'revalidate_extra') response.snapshot = { private: 'private-fixture-value' };
  }
  if (fault === 'wrong_id') response.requestId = 'wrong_id';
  if (fault === 'wrong_launch') response.launchId = 'wrong_launch';
  const stream = createReadStream(null, { fd: 7, autoClose: true });
  for await (const chunk of stream) { if (chunk.includes(10)) break; }
  if (fault === 'oversized') process.stdout.write('x'.repeat(8193));
  else if (fault === 'invalid_json') process.stdout.write('private-fixture-value\n');
  else if (fault === 'truncated') process.stdout.write(JSON.stringify(response));
  else if (fault === 'extra_frame') process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(response)}\n`);
  else process.stdout.write(`${JSON.stringify(response)}\n`);
}
