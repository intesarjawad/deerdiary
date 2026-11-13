import type { Server } from 'node:http';

export function parseArgs(argv: string[]): { port: number; open: boolean };
export function nodeVersionError(current: string, range: string): string | null;
export function startServer(options: { root: string; port: number }): Promise<{
  server: Server;
  url: string;
}>;
