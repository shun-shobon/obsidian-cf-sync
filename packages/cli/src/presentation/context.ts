export interface CliContext {
  env: NodeJS.ProcessEnv;
  output: (text: string) => void;
  exitCode: number;
}
