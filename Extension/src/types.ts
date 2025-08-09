export type JupyterServerRequestResponse = {
  status: string;
  message: string;
  server_info: {
    pre: string;
    port: number;
    token: string;
    url: string;
  };
};

export type BitswanJupyterServer = {
  pre: string;
  port: number;
  token: string;
  url: string;
  automationName: string;
};

export type BitswanJupyterServerRecords = Record<string, BitswanJupyterServer>;
