/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STATIC_LAB?: string;
  readonly VITE_LAB_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
