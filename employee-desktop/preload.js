const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("employeeClient", {
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
  start: () => ipcRenderer.send("start"),
  stop: () => ipcRenderer.send("stop"),
  uploadNow: () => ipcRenderer.send("upload-now"),
  updateProfile: (profile) => ipcRenderer.send("update-profile", profile),
  hide: () => ipcRenderer.send("hide"),
});
