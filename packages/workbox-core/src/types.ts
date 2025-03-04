/*
  Copyright 2019 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import './_version.js';


/**
 * Options passed to a `RouteMatchCallback` function.
 */
export interface RouteMatchCallbackOptions {
  url: URL;
  request: Request;
  event?: ExtendableEvent;
}

/**
 * The "match" callback is used to determine if a `Route` should apply for a
 * particular URL and request. When matching occurs in response to a fetch
 * event from the client, the `event` object is also supplied. However, since
 * the match callback can be invoked outside of a fetch event, matching logic
 * should not assume the `event` object will always be available.
 * If the match callback returns a truthy value, the matching route's
 * `RouteHandlerCallback` will be invoked immediately. If the value returned
 * is a non-empty array or object, that value will be set on the handler's
 * `options.params` argument.
 */
export interface RouteMatchCallback {
  ({url, request, event}: RouteMatchCallbackOptions): any;
}

/**
 * Options passed to a `RouteHandlerCallback` function.
 */
export interface RouteHandlerCallbackOptions extends RouteMatchCallbackOptions {
  params?: string[] | {[paramName: string]: string};
}

/**
 * The "handler" callback is invoked whenever a `Router` matches a URL/Request
 * to a `Route` via its `RouteMatchCallback`. This handler callback should
 * return a `Promise` that resolves with a `Response`.
 *
 * If a non-empty array or object is returned by the `RouteMatchCallback` it
 * will be passed in as this handler's `options.params` argument.
 */
export interface RouteHandlerCallback {
  ({url, request, event, params}: RouteHandlerCallbackOptions): Promise<Response>;
}

/**
 * An object with a `handle` method of type `RouteHandlerCallback`.
 *
 * A `Route` object can be created with either an `RouteHandlerCallback`
 * function or this `RouteHandler` object. The benefit of the `RouteHandler`
 * is it can be extended (as is done by the `workbox-strategies` package).
 */
export interface RouteHandler {
  handle(opts: RouteHandlerCallbackOptions): Promise<Response>;
}

interface CacheDidUpdateCallback {
  ({cacheName, oldResponse, newResponse, request, event}: {
    cacheName: string,
    oldResponse?: Response,
    newResponse: Response,
    request: Request,
    event?: FetchEvent
  }): Promise<void | null | undefined>;
}

interface CacheKeyWillBeUsedCallback {
  ({request, mode}: {
    request: Request,
    mode: string,
  }): Promise<Request | string>;
}

interface CacheWillUpdateCallback {
  ({response, request, event}: {
    response: Response,
    request?: Request,
    event?: ExtendableEvent,
  }): Promise<Response | void | null | undefined>;
}

interface CachedResponseWillBeUsedCallback {
  ({cacheName, request, matchOptions, cachedResponse, event}: {
    cacheName: string,
    request: Request,
    matchOptions?: CacheQueryOptions,
    cachedResponse?: Response,
    event?: ExtendableEvent,
  }): Promise<Response | void | null | undefined>;
}

interface FetchDidFailCallback {
  ({originalRequest, request, error, event}: {
    originalRequest: Request,
    error: Error,
    request: Request,
    event?: ExtendableEvent,
  }): Promise<void | null | undefined>;
}

interface FetchDidSucceedCallback {
  ({request, response}: {
    request: Request,
    response: Response,
  }): Promise<Response>
}

interface RequestWillFetchCallback {
  ({request}: {
    request: Request
  }): Promise<void | null | undefined>
}

/**
 * An object with optional lifecycle callback properties for the fetch and
 * cache operations.
 */
export interface WorkboxPlugin {
  cacheDidUpdate?: CacheDidUpdateCallback;
  cacheKeyWillBeUsed?: CacheKeyWillBeUsedCallback;
  cacheWillUpdate?: CacheWillUpdateCallback;
  cachedResponseWillBeUsed?: CachedResponseWillBeUsedCallback;
  fetchDidFail?: FetchDidFailCallback;
  fetchDidSucceed?: FetchDidSucceedCallback;
  requestWillFetch?: RequestWillFetchCallback;
}
