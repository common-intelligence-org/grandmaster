import { createInterface } from 'node:readline';
import { createUciHandler } from './uci.ts';

const handler = createUciHandler();
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (line.trim() === 'quit') {
    rl.close();
    return;
  }
  const outputs = handler.handleLine(line);
  for (const out of outputs) {
    process.stdout.write(out + '\n');
  }
});
