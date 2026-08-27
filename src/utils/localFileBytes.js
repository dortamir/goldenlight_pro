import { File } from 'expo-file-system';

// STAGE 15.2 FOLLOW-UP: reads a local (native file://) URI's real bytes into
// an ArrayBuffer for direct upload, used by purchaseReportService.js and
// profileService.js's avatar upload. Deliberately NOT wrapped in React
// Native's own `Blob` class - RN's `Blob` (react-native/Libraries/Blob/
// Blob.js) only supports constructing a Blob from OTHER Blobs ("Currently we
// only support creating Blobs from other Blobs", per its own doc comment),
// not from raw bytes, and represents its data as an opaque reference into
// native-side storage rather than real in-JS bytes - re-uploading a Blob
// built from `fetch(uri).blob()` through a second fetch call proved
// unreliable for local files on a physical iPhone (new receipt uploads never
// completed). A plain ArrayBuffer is a standard, spec-compliant fetch/XHR
// body type that React Native's networking bridge supports directly, with
// no dependency on RN's own limited Blob implementation.
//
// SDK-54 PORTABILITY: this is the only place in the app that touches
// expo-file-system's `File` class for this purpose - if the SDK-54 iPhone
// test shell ends up on an incompatible expo-file-system version, only this
// one function needs an SDK-54-specific implementation.
export async function readLocalFileAsArrayBuffer(uri) {
  const file = new File(uri);
  return file.arrayBuffer();
}