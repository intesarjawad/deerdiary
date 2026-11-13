const [command, task] = process.argv.slice(2);
console.error(`PENDING: ${command} is not built yet (${task}). See docs/development.md.`);
process.exitCode = 1;
