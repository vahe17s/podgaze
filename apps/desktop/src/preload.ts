import { contextBridge, ipcRenderer } from "electron";
import { createPreloadClient } from "./ipc.js";

contextBridge.exposeInMainWorld("podgaze", createPreloadClient(ipcRenderer));
contextBridge.exposeInMainWorld("podgazeWindow", {
  minimize: () => ipcRenderer.invoke("podgaze:window", "minimize"),
  maximize: () => ipcRenderer.invoke("podgaze:window", "maximize"),
  close: () => ipcRenderer.invoke("podgaze:window", "close"),
});
