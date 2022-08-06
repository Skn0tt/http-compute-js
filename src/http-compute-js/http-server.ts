/*
 * Copyright Fastly, Inc.
 * Licensed under the MIT license. See LICENSE file for details.
 */

// This file modeled after Node.js - /lib/_http_server.js

import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'http';

import {
  ERR_HTTP_HEADERS_SENT,
  ERR_HTTP_INVALID_STATUS_CODE, ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_CHAR,
  ERR_METHOD_NOT_IMPLEMENTED,
} from '../utils/errors';
import { ComputeJsOutgoingMessage } from './http-outgoing';
import { chunkExpression } from './http-common';
import { ComputeJsIncomingMessage } from './http-incoming';
import { kOutHeaders } from './internal-http';

const headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/;
/**
 * True if val contains an invalid field-vchar
 *  field-value    = *( field-content / obs-fold )
 *  field-content  = field-vchar [ 1*( SP / HTAB ) field-vchar ]
 *  field-vchar    = VCHAR / obs-text
 */
function checkInvalidHeaderChar(val: string): boolean {
  return headerCharRegex.exec(val) !== null;
}

const STATUS_CODES: Record<number, string> = {
  100: 'Continue',                   // RFC 7231 6.2.1
  101: 'Switching Protocols',        // RFC 7231 6.2.2
  102: 'Processing',                 // RFC 2518 10.1 (obsoleted by RFC 4918)
  103: 'Early Hints',                // RFC 8297 2
  200: 'OK',                         // RFC 7231 6.3.1
  201: 'Created',                    // RFC 7231 6.3.2
  202: 'Accepted',                   // RFC 7231 6.3.3
  203: 'Non-Authoritative Information', // RFC 7231 6.3.4
  204: 'No Content',                 // RFC 7231 6.3.5
  205: 'Reset Content',              // RFC 7231 6.3.6
  206: 'Partial Content',            // RFC 7233 4.1
  207: 'Multi-Status',               // RFC 4918 11.1
  208: 'Already Reported',           // RFC 5842 7.1
  226: 'IM Used',                    // RFC 3229 10.4.1
  300: 'Multiple Choices',           // RFC 7231 6.4.1
  301: 'Moved Permanently',          // RFC 7231 6.4.2
  302: 'Found',                      // RFC 7231 6.4.3
  303: 'See Other',                  // RFC 7231 6.4.4
  304: 'Not Modified',               // RFC 7232 4.1
  305: 'Use Proxy',                  // RFC 7231 6.4.5
  307: 'Temporary Redirect',         // RFC 7231 6.4.7
  308: 'Permanent Redirect',         // RFC 7238 3
  400: 'Bad Request',                // RFC 7231 6.5.1
  401: 'Unauthorized',               // RFC 7235 3.1
  402: 'Payment Required',           // RFC 7231 6.5.2
  403: 'Forbidden',                  // RFC 7231 6.5.3
  404: 'Not Found',                  // RFC 7231 6.5.4
  405: 'Method Not Allowed',         // RFC 7231 6.5.5
  406: 'Not Acceptable',             // RFC 7231 6.5.6
  407: 'Proxy Authentication Required', // RFC 7235 3.2
  408: 'Request Timeout',            // RFC 7231 6.5.7
  409: 'Conflict',                   // RFC 7231 6.5.8
  410: 'Gone',                       // RFC 7231 6.5.9
  411: 'Length Required',            // RFC 7231 6.5.10
  412: 'Precondition Failed',        // RFC 7232 4.2
  413: 'Payload Too Large',          // RFC 7231 6.5.11
  414: 'URI Too Long',               // RFC 7231 6.5.12
  415: 'Unsupported Media Type',     // RFC 7231 6.5.13
  416: 'Range Not Satisfiable',      // RFC 7233 4.4
  417: 'Expectation Failed',         // RFC 7231 6.5.14
  418: 'I\'m a Teapot',              // RFC 7168 2.3.3
  421: 'Misdirected Request',        // RFC 7540 9.1.2
  422: 'Unprocessable Entity',       // RFC 4918 11.2
  423: 'Locked',                     // RFC 4918 11.3
  424: 'Failed Dependency',          // RFC 4918 11.4
  425: 'Too Early',                  // RFC 8470 5.2
  426: 'Upgrade Required',           // RFC 2817 and RFC 7231 6.5.15
  428: 'Precondition Required',      // RFC 6585 3
  429: 'Too Many Requests',          // RFC 6585 4
  431: 'Request Header Fields Too Large', // RFC 6585 5
  451: 'Unavailable For Legal Reasons', // RFC 7725 3
  500: 'Internal Server Error',      // RFC 7231 6.6.1
  501: 'Not Implemented',            // RFC 7231 6.6.2
  502: 'Bad Gateway',                // RFC 7231 6.6.3
  503: 'Service Unavailable',        // RFC 7231 6.6.4
  504: 'Gateway Timeout',            // RFC 7231 6.6.5
  505: 'HTTP Version Not Supported', // RFC 7231 6.6.6
  506: 'Variant Also Negotiates',    // RFC 2295 8.1
  507: 'Insufficient Storage',       // RFC 4918 11.5
  508: 'Loop Detected',              // RFC 5842 7.2
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',               // RFC 2774 7
  511: 'Network Authentication Required' // RFC 6585 6
};


export class ComputeJsServerResponse extends ComputeJsOutgoingMessage implements ServerResponse {

  statusCode: number = 200;
  statusMessage!: string;

  _sent100: boolean;
  _expect_continue: boolean;

  [kOutHeaders]: Record<string, any> | null = null;

  constructor(req: IncomingMessage) {
    super(req);

    if (req.method === 'HEAD') {
      this._hasBody = false;
    }

    // this.req = req; // super() actually does this
    this.sendDate = true;
    this._sent100 = false;
    this._expect_continue = false;

    if (req.httpVersionMajor < 1 || req.httpVersionMinor < 1) {
      this.useChunkedEncodingByDefault = chunkExpression.exec(String(req.headers.te)) !== null;
      this.shouldKeepAlive = false;
    }

    /*
    if (hasObserver('http')) {
      startPerf(this, kServerResponseStatistics, {
        type: 'http',
        name: 'HttpRequest',
        detail: {
          req: {
            method: req.method,
            url: req.url,
            headers: req.headers,
          },
        },
      });
    }
    */
  }

  override _finish() {
    /*
    if (this[kServerResponseStatistics] && hasObserver('http')) {
      stopPerf(this, kServerResponseStatistics, {
        detail: {
          res: {
            statusCode: this.statusCode,
            statusMessage: this.statusMessage,
            headers: typeof this.getHeaders === 'function' ? this.getHeaders() : {},
          },
        },
      });
    }
    */
    super._finish();
  }

  assignSocket(socket: any): void {
    throw new ERR_METHOD_NOT_IMPLEMENTED('assignSocket');
  }

  detachSocket(socket: any): void {
    throw new ERR_METHOD_NOT_IMPLEMENTED('detachSocket');
  }

  writeContinue(callback?: () => void): void {
    this._writeRaw('HTTP/1.1 100 Continue\r\n\r\n', 'ascii', callback);
    this._sent100 = true;
  }

  writeProcessing(callback?: () => void): void {
    this._writeRaw('HTTP/1.1 102 Processing\r\n\r\n', 'ascii', callback);
  }

  override _implicitHeader() {
    this.writeHead(this.statusCode);
  }

  writeHead(
    statusCode: number,
    reason?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    obj?: OutgoingHttpHeaders | OutgoingHttpHeader[]
  ): this {
    const originalStatusCode = statusCode;

    statusCode |= 0;
    if (statusCode < 100 || statusCode > 999) {
      throw new ERR_HTTP_INVALID_STATUS_CODE(originalStatusCode);
    }

    if (typeof reason === 'string') {
      // writeHead(statusCode, reasonPhrase[, headers])
      this.statusMessage = reason;
    } else {
      // writeHead(statusCode[, headers])
      if (!this.statusMessage)
        this.statusMessage = STATUS_CODES[statusCode] || 'unknown';
      obj = reason;
    }
    this.statusCode = statusCode;

    let headers;
    if (this[kOutHeaders]) {
      // Slow-case: when progressive API and header fields are passed.
      let k;
      if (Array.isArray(obj)) {
        if (obj.length % 2 !== 0) {
          throw new ERR_INVALID_ARG_VALUE('headers', obj);
        }

        for (let n = 0; n < obj.length; n += 2) {
          k = obj[n];
          if (k) {
            this.setHeader(k as string, obj[n + 1]);
          }
        }
      } else if (obj) {
        const keys = Object.keys(obj);
        // Retain for(;;) loop for performance reasons
        // Refs: https://github.com/nodejs/node/pull/30958
        for (let i = 0; i < keys.length; i++) {
          k = keys[i];
          if (k) {
            this.setHeader(k, obj[k]!);
          }
        }
      }
      if (k === undefined && this._header) {
        throw new ERR_HTTP_HEADERS_SENT('render');
      }
      // Only progressive api is used
      headers = this[kOutHeaders];
    } else {
      // Only writeHead() called
      headers = obj;
    }

    if (checkInvalidHeaderChar(this.statusMessage))
      throw new ERR_INVALID_CHAR('statusMessage');

    const statusLine = `HTTP/1.1 ${statusCode} ${this.statusMessage}\r\n`;

    if (statusCode === 204 || statusCode === 304 ||
      (statusCode >= 100 && statusCode <= 199)) {
      // RFC 2616, 10.2.5:
      // The 204 response MUST NOT include a message-body, and thus is always
      // terminated by the first empty line after the header fields.
      // RFC 2616, 10.3.5:
      // The 304 response MUST NOT contain a message-body, and thus is always
      // terminated by the first empty line after the header fields.
      // RFC 2616, 10.1 Informational 1xx:
      // This class of status code indicates a provisional response,
      // consisting only of the Status-Line and optional headers, and is
      // terminated by an empty line.
      this._hasBody = false;
    }

    // Don't keep alive connections where the client expects 100 Continue
    // but we sent a final status; they may put extra bytes on the wire.
    if (this._expect_continue && !this._sent100) {
      this.shouldKeepAlive = false;
    }

    this._storeHeader(statusLine, headers ?? null);

    return this;
  }

  writeHeader = this.writeHead;
}

type RequestResponse = {
  req: IncomingMessage,
  res: ServerResponse,
};

export function generateRequestResponse(req: Request): RequestResponse {

  const incoming = new ComputeJsIncomingMessage();
  const serverResponse = new ComputeJsServerResponse(incoming);

  const reqUrl = new URL(req.url);

  // In C@E I don't think you can actually detect HTTP version, so we'll use 1.1
  // Who uses this anyway?
  const versionMajor = 1;
  const versionMinor = 1;
  incoming.httpVersionMajor = versionMajor;
  incoming.httpVersionMinor = versionMinor;
  incoming.httpVersion = `${versionMajor}.${versionMinor}`;
  incoming.url = reqUrl.pathname + reqUrl.search;
  incoming.upgrade = false; // TODO: support this, if there is some way to do it

  const headers = [];
  for (const [headerName, headerValue] of req.headers) {
    headers.push(headerName);
    headers.push(headerValue);
  }

  incoming._addHeaderLines(headers, headers.length);

  incoming.method = req.method;
  incoming._stream = req.body;

  return {
    req: incoming,
    res: serverResponse,
  };

}

export function toComputeResponse(res: ServerResponse) {
  if(!(res instanceof ComputeJsServerResponse)) {
    throw new Error('toComputeResponse must be called on ServerResponse generated by generateRequestResponse');
  }

  const body = new ReadableStream({
    start(controller) {
      // First packet contains the header. sigh.
      for (const [index, packet] of res.outputData.entries()) {
        let { data, encoding } = packet;
        if(index === 0) {
          if(typeof data !== 'string') {
            console.error('First chunk should be string, not sure what happened.');
            throw new ERR_INVALID_ARG_TYPE('packet.data', [ 'string', 'Buffer', 'Uint8Array' ], data);
          }
          // The first X bytes are header material, so we remove it.
          data = data.slice(res.writtenHeaderBytes);
        }

        if(typeof data === 'string') {
          data = Buffer.from(data, encoding);
        }

        controller.enqueue(data);
      }
    },
  });

  const status = res.statusCode;

  const headers = new Headers();
  for (const [key, value] of Object.entries(res.getHeaders())) {
    if(Array.isArray(value)) {
      for(const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.append(key, String(value));
    }
  }

  return new Response(body, {
    status,
    headers,
  });
}