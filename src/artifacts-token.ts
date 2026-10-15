import { z } from 'zod';

// ArtifactToken is opaque provider output, not a SHA-1 hash. Keep a bounded,
// header-safe value and its explicit expiry without assuming its secret length.
export const artifactTokenSchema = z.string().max(1024).regex(/^[\x21-\x3e\x40-\x7e]+\?expires=[0-9]{10,12}$/);
