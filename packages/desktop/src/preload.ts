import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';

function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void) {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('davecodeDesktop', {
  platform: process.platform,
  chooseProject: () => ipcRenderer.invoke('desktop:choose-project'),
  workspace: {
    load: () => ipcRenderer.invoke('workspace:load'),
    save: (state: unknown) => ipcRenderer.invoke('workspace:save', state),
  },
  preferences: {
    load: () => ipcRenderer.invoke('preferences:load'),
    save: (value: unknown) => ipcRenderer.invoke('preferences:save', value),
  },
  detectAgents: () => ipcRenderer.invoke('agents:detect'),
  detectShells: () => ipcRenderer.invoke('shells:detect'),
  notify: (request: unknown) => ipcRenderer.invoke('desktop:notify', request),
  onNotificationClick: (listener: (target: unknown) => void) =>
    subscribe('notification:click', listener),
  terminal: {
    open: (request: unknown) => ipcRenderer.invoke('terminal:open', request),
    write: (request: unknown) => ipcRenderer.invoke('terminal:write', request),
    resize: (request: unknown) => ipcRenderer.invoke('terminal:resize', request),
    close: (id: string) => ipcRenderer.invoke('terminal:close', id),
    copy: (text: string) => ipcRenderer.invoke('terminal:copy', text),
    readClipboard: () => ipcRenderer.invoke('terminal:read-clipboard'),
    onData: (listener: (id: string, data: string) => void) => subscribe('terminal:data', listener),
    onExit: (listener: (id: string, code: number) => void) => subscribe('terminal:exit', listener),
  },
});
