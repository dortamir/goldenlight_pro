import { Platform } from 'react-native';
import { File } from 'expo-file-system';

// STAGE 15.1 FOLLOW-UP: reads a local image file's real magic-number
// signature so the app never has to trust expo-image-picker's self-reported
// `mimeType`/`fileName` alone - which, since Expo SDK 54, can legitimately
// disagree with the actual bytes. As of SDK 54+, ImagePicker's default
// `allowsEditing: false` configuration returns the ORIGINAL captured/picked
// asset untouched ("the picker skips compression") - including native HEIC
// photos, which is the iPhone Camera app's default capture format on every
// iPhone since the iPhone 7. A camera photo can therefore be real HEIC bytes
// while `asset.mimeType`/`asset.fileName` are missing or (rarely) stale, and
// this app's upload code used to trust those fields blindly - uploading a
// Storage object with a `Content-Type` header that didn't match its actual
// bytes, which most image decoders refuse to render, producing a blank
// thumbnail despite a fully successful upload.
//
// The file is read once via `File#arrayBuffer()` (expo-file-system's `File`
// implements the standard `Blob` interface) and only the first 16 bytes of
// the resulting buffer are inspected - a single one-time read at
// picker-selection time, not per-render.
//
// SDK-54 PORTABILITY: `detectImageFormat(uri)` is this module's only export
// and the only thing any caller (PurchaseScreen.js) touches - the SDK-57
// `expo-file-system` `File` class used internally is fully contained here.
// If the SDK-54 iPhone test shell ends up on an older `expo-file-system`
// without this `File` class, only the body of this one function needs an
// SDK-54-specific byte-reading implementation (e.g. the older
// `readAsStringAsync(uri, {encoding: 'base64', length, position})`
// function-based API) - no call site anywhere else in the app changes.

// HEIC/HEIF files use the same ISO-BMFF container as MP4: a 4-byte size,
// then `ftyp`, then a 4-byte "brand" identifying the specific format. These
// are every brand Apple's camera/Photos pipeline is known to emit.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

function bytesToAscii(bytes, start, end) {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

// Returns 'jpeg' | 'png' | 'webp' | 'heic' | 'unknown'. Never throws -
// callers must treat 'unknown' as "could not verify" and fall back to their
// own existing metadata-based handling, not as "definitely unsupported".
export async function detectImageFormat(uri) {
  // expo-file-system's `File` targets native local file:// paths - not
  // guaranteed for web's blob:/data: URIs, and web never sees this
  // HEIC-passthrough behavior in the first place (browsers
  // don't hand a <input type="file"> camera capture back as HEIC), so this
  // check is native-only by design, not a workaround for a failure.
  if (!uri || Platform.OS === 'web') {
    return 'unknown';
  }

  try {
    const file = new File(uri);
    // expo-file-system's `File` implements the Blob interface - reading the
    // whole file into memory once at picker-selection time (not per-render)
    // is simpler and more certain to work across platforms than slicing a
    // byte range, and receipt photos are small enough that this is cheap.
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'jpeg';
    }

    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'png';
    }

    if (bytes.length >= 12 && bytesToAscii(bytes, 0, 4) === 'RIFF' && bytesToAscii(bytes, 8, 12) === 'WEBP') {
      return 'webp';
    }

    if (bytes.length >= 12 && bytesToAscii(bytes, 4, 8) === 'ftyp' && HEIC_BRANDS.has(bytesToAscii(bytes, 8, 12))) {
      return 'heic';
    }

    return 'unknown';
  } catch (error) {
    if (__DEV__) {
      console.warn('[ReceiptImageFormat] Could not read file signature, falling back to metadata', error?.message);
    }
    return 'unknown';
  }
}