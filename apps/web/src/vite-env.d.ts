/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BOT_EXECUTION_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
