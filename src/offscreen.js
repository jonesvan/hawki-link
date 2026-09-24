// Offscreen document used only to keep the service worker alive while an agent
// task is running. Chrome may terminate an idle MV3 service worker; keeping an
// offscreen document open prevents that for the duration of a run.

setInterval(() => {
  // Heartbeat. The mere existence of this document keeps the worker alive.
}, 20000);
