export const ALLOWED_CAPABILITIES = [
    "allow-downloads",
    "allow-forms",
    "allow-modals",
    "allow-orientation-lock",
    "allow-pointer-lock",
    "allow-popups",
    "allow-presentation",
    "allow-scripts",
] as const;

export type SandboxCapability = (typeof ALLOWED_CAPABILITIES)[number];

export interface CSPDirectives {
    "upgrade-insecure-requests": true;
    "default-src"?: string[];
    "script-src"?: string[];
    "connect-src"?: string[];
    "base-uri"?: string[];
    "img-src"?: string[];
    "style-src"?: string[];
    "font-src"?: string[];
    "media-src"?: string[];
    "manifest-src"?: string[];
    "prefetch-src"?: string[];
    "form-action"?: string[];
    "object-src"?: string[]; // <embed, <object, ...
    "frame-src"?: string[]; // specifies sources where iframes in this page can be loaded from
    "frame-ancestors"?: string[]; // specifies parent sources that are allowed to embed this page using <frame>, <iframe>, <object>, or <embed>
    "worker-src"?: string[]; // 'blob' or 'data' might be needed for frontend-frameworks to spawn workers
}
