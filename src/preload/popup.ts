// Preload of the panels page (popup.html): it shows what it is given and sends back the
// user's choices, nothing else.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PopupData, PopupShow } from '../shared/types';

contextBridge.exposeInMainWorld('popup', {
  onShow(cb: (data: PopupShow) => void) {
    const fn = (_e: IpcRendererEvent, data: PopupShow) => cb(data);
    ipcRenderer.on('popup:show', fn);
    return () => ipcRenderer.removeListener('popup:show', fn);
  },
  onData(cb: (data: PopupData) => void) {
    const fn = (_e: IpcRendererEvent, data: PopupData) => cb(data);
    ipcRenderer.on('popup:data', fn);
    return () => ipcRenderer.removeListener('popup:data', fn);
  },
  act: (id: string, arg?: unknown) => ipcRenderer.invoke('popup:act', id, arg),
  close: () => ipcRenderer.send('popup:close'),
});
