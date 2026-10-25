import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('davecodeDesktop', {
  chooseProject: () => ipcRenderer.invoke('desktop:choose-project'),
});
