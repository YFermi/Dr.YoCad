/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SOCKET_URL?: string;
  /** "true" for the STANDALONE build (vite --mode standalone). */
  readonly VITE_STANDALONE?: string;
}
