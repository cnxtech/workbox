/*
  Copyright 2019 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {Workbox} from '/__WORKBOX/buildFile/workbox-window';


const isDev = () => {
  return self.process && self.process.env &&
      self.process.env.NODE_ENV !== 'production';
};

const sleep = async (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const waitUntil = async (condition, timeout = 2000) => {
  const startTime = performance.now();
  while (!condition()) {
    if (performance.now() > startTime + timeout) {
      const error = new Error(`Timed out after ${timeout}ms.`);
      console.error(error);
      throw error;
    }
    await sleep(100);
  }
};

const nextEvent = (obj, eventType) => {
  return new Promise((resolve) => obj.addEventListener(eventType, resolve));
};

const uniq = (() => {
  let timestamp = Date.now();
  let uid = 0;
  return (scriptURL) => {
    const url = new URL(scriptURL, location);
    url.searchParams.set('_id', `${++uid}-${timestamp}`);

    return url.toString();
  };
})();


const stubAlreadyControllingSW = async (scriptURL) => {
  await navigator.serviceWorker.register(scriptURL);
  await waitUntil(() => {
    return navigator.serviceWorker.controller &&
        navigator.serviceWorker.controller.scriptURL.endsWith(scriptURL);
  });
};

const updateVersion = async (version, scriptURL) => {
  // Dynamically update the version string in the SW script.
  await fetch(`/__WORKBOX/updateTemplate`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({version}),
  });

  // If a script URL is passed, wait until a request for that script returns
  // the newly set version.
  let tries = 0;
  if (scriptURL) {
    while (++tries < 10) {
      const resp = await fetch(scriptURL);
      const text = await resp.text();
      if (text.indexOf(version) > -1) {
        return;
      } else {
        await sleep(100);
      }
    }
  }
  throw new Error('No updated version found after 10 retries');
};

const assertMatchesWorkboxEvent = (event, props) => {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'originalEvent' && typeof value !== 'undefined') {
      expect(event.originalEvent.type).to.equal(value.type);
    } else {
      expect(event[key]).to.equal(value);
    }
  }
};

const sandbox = sinon.createSandbox();

describe(`[workbox-window] Workbox`, function() {
  // Since it's not possible to completely unregister a controlling SW from
  // a page (without closing all clients, including the current window), it's
  // also not possible to run unit tests all from a fresh start in a single
  // page load.
  // Thus, to make these tests as predictable as possible, we start all unit
  // tests with a controlling SW and only test the things that don't need to
  // assert fresh-install behavior. Anything that does must be tested with
  // integration tests.
  beforeEach(async function() {
    const scriptURL = uniq('sw-clients-claim.js.njk');
    await updateVersion('1.0.0', scriptURL);
    await stubAlreadyControllingSW(scriptURL);

    sandbox.restore();
    sandbox.spy(console, 'debug');
    sandbox.spy(console, 'log');
    sandbox.spy(console, 'warn');
    sandbox.spy(console, 'error');
  });

  afterEach(async function() {
    sandbox.restore();
  });

  describe(`constructor`, function() {
    it(`creates an instance of the Workbox class`, async function() {
      const wb = new Workbox(uniq('sw-clients-claim.js.njk'));
      expect(wb).to.be.instanceOf(Workbox);
    });

    it(`does not register a SW`, function(done) {
      sandbox.spy(navigator.serviceWorker, 'register');

      new Workbox(uniq('sw-clients-claim.js.njk'));

      // Queue a task to ensure a SW isn't registered async.
      setTimeout(() => {
        // Not calling addEventListener means Workbox properly detected that
        // the window was already loaded
        expect(navigator.serviceWorker.register.callCount).to.equal(0);
        done();
      }, 0);
    });
  });

  describe(`register`, function() {
    it(`registers a service worker if the window is loaded`, async function() {
      sandbox.spy(navigator.serviceWorker, 'register');
      sandbox.spy(self, 'addEventListener');

      const scriptURL = uniq('sw-no-skip-waiting.js.njk');
      const wb = new Workbox(scriptURL);
      await wb.register();

      // Not calling addEventListener means Workbox properly detected that
      // the window was already loaded
      expect(self.addEventListener.calledWith('load')).to.not.equal(true);
      expect(navigator.serviceWorker.register.callCount).to.equal(1);
      expect(navigator.serviceWorker.register.args[0][0]).to.equal(scriptURL);
    });

    it(`defers registration until after load by default`, async function() {
      sandbox.spy(navigator.serviceWorker, 'register');
      sandbox.spy(self, 'addEventListener');

      // Stub the window not yet being loaded
      sandbox.stub(document, 'readyState').value('loading');

      // Trigger the load event in the next task.
      setTimeout(() => self.dispatchEvent(new Event('load'), 0));

      const wb = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
      await wb.register();

      expect(self.addEventListener.calledWith('load')).to.equal(true);
      expect(self.addEventListener.args[0][0]).to.equal('load');
    });

    it(`supports not deferring until load`, async function() {
      sandbox.spy(navigator.serviceWorker, 'register');
      sandbox.spy(self, 'addEventListener');

      // Stub the window not yet being loaded
      sandbox.stub(document, 'readyState').value('loading');

      // Trigger the load event in the next task.
      setTimeout(() => self.dispatchEvent(new Event('load'), 0));

      const wb = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
      await wb.register({immediate: true});

      expect(self.addEventListener.calledWith('load')).to.not.equal(true);
    });

    it(`errors when registration fails`, async function() {
      const wb = new Workbox(uniq('sw-error.js'));

      try {
        await wb.register();
        // We shouldn't get here because the above line should fail.
        throw new Error('unexpected');
      } catch (error) {
        expect(error.name).to.equal('TypeError');
        expect(error.message).not.to.match(/unexpected/i);
      }
    });

    it(`notifies the SW that the window is ready if the registered SW is already controlling the page`, async function() {
      // Gets the URL of the currently controlling SW.
      const controllingSW = navigator.serviceWorker.controller;
      const {scriptURL} = controllingSW;
      sandbox.stub(controllingSW, 'postMessage');

      await new Workbox(scriptURL).register();

      expect(controllingSW.postMessage.callCount).to.equal(1);
      expect(controllingSW.postMessage.args[0][0]).to.deep.equal({
        type: 'WINDOW_READY',
        meta: 'workbox-window',
      });

      // Test that no message is sent if the SW wasn't already controlling the
      // page at registration time.
      await new Workbox(scriptURL + '&nocache').register();
      expect(controllingSW.postMessage.callCount).to.equal(1);
    });

    describe(`logs in development-only`, function() {
      it(`(debug) if a SW with the same script URL is already controlling the page`, async function() {
        if (!isDev()) this.skip();

        // Gets the URL of the currently controlling SW.
        const {scriptURL} = navigator.serviceWorker.controller;

        const wb = new Workbox(scriptURL);
        await wb.register();

        expect(console.debug.callCount).to.equal(1);
        expect(console.debug.args[0][2]).to.match(/same/i);
      });

      it(`(debug) if a SW with a different script URL is already controlling the page`, async function() {
        if (!isDev()) this.skip();

        const wb = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        await wb.register();

        expect(console.debug.callCount).to.equal(1);
        expect(console.debug.args[0][2]).to.match(/different/i);
        expect(console.debug.args[0][2]).to.match(/new/i);
      });

      it(`(info) when registration is successful`, async function() {
        if (!isDev()) this.skip();

        sandbox.spy(navigator.serviceWorker, 'register');

        const wb = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        await wb.register();

        expect(console.log.callCount).to.equal(1);
        expect(console.log.args[0][2]).to.match(/success/i);
      });

      it(`(warn) when the registered SW is not in scope for the current page`, async function() {
        if (!isDev()) this.skip();

        sandbox.spy(navigator.serviceWorker, 'register');

        const wb = new Workbox(uniq('/out-of-scope/sw-clients-claim.js.njk'));
        await wb.register();

        expect(console.warn.callCount).to.equal(1);
        expect(console.warn.args[0][2]).to.include('scope');
      });

      it(`(warn) when a service worker is installed but now waiting`, async function() {
        if (!isDev()) this.skip();

        const wb = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        await wb.register();

        await waitUntil(() => console.warn.callCount === 1);
        expect(console.warn.args[0][2]).to.match(/waiting/i);
      });

      it(`(error) when registration fails`, async function() {
        if (!isDev()) this.skip();

        const wb = new Workbox(uniq('sw-error.js'));

        try {
          await wb.register();
          // We shouldn't get here because the above line should fail.
          throw new Error('unexpected');
        } catch (error) {
          expect(error.name).to.equal('TypeError');
          expect(console.error.callCount).to.equal(1);
          expect(console.error.args[0][2].message).to.equal(error.message);
        }
      });

      it(`(error) if calling register twice`, async function() {
        if (!isDev()) this.skip();

        const wb = new Workbox(uniq('sw-clients-claim.js.njk'));
        await wb.register();
        await wb.active;

        await wb.register();
        expect(console.error.callCount).to.equal(1);
        expect(console.error.args[0][2]).to.match(/cannot re-register/i);
      });
    });
  });

  describe(`update`, function() {
    it(`updates service worker and resolves with the new registration`, async function() {
      const controllerBeforeTest = navigator.serviceWorker.controller;
      const scriptURL = controllerBeforeTest.scriptURL;
      const wb = new Workbox(scriptURL);

      const reg = await wb.register();
      const newReg = await wb.update();

      expect(reg).not.to.equal(newReg);
    });

    describe(`logs in development-only`, function() {
      it(`(error) if calling without registration`, async function() {
        if (!isDev()) this.skip();

        const wb = new Workbox(uniq('sw-clients-claim.js.njk'));

        await wb.update();
        expect(console.error.callCount).to.equal(1);
        expect(console.error.args[0][2]).to.match(/cannot update/i);
      });
    });
  });

  describe(`active`, function() {
    it(`resolves as soon as the registered SW is active`, async function() {
      const controllerBeforeTest = navigator.serviceWorker.controller;
      const scriptURL = controllerBeforeTest.scriptURL;
      const wb = new Workbox(scriptURL);

      // Registering using the same script URL that's already active won't
      // trigger an update.
      const reg = await wb.register();
      const sw = await wb.active;

      expect(sw).to.equal(reg.active);
      expect(sw).to.equal(controllerBeforeTest);
    });

    it(`waits for an update if the scriptURLs don't match`, async function() {
      const controllerBeforeTest = navigator.serviceWorker.controller;
      const scriptURL = uniq('sw-clients-claim.js.njk');
      const wb = new Workbox(scriptURL);

      // Registering using a different script URL should trigger an update,
      // and `.active` shouldn't resolve until after the update.
      const reg = await wb.register();
      const sw = await wb.active;

      expect(sw).to.equal(reg.active);
      expect(sw).to.not.equal(controllerBeforeTest);
    });
  });

  describe(`controlling`, function() {
    it(`resolves as soon as the registered SW is controlling`, async function() {
      const controllerBeforeTest = navigator.serviceWorker.controller;
      const scriptURL = controllerBeforeTest.scriptURL;
      const wb = new Workbox(scriptURL);

      // Registering using the same script URL that's already controlling
      // won't trigger an update.
      await wb.register();
      const sw = await wb.controlling;

      expect(sw).to.equal(navigator.serviceWorker.controller);
      expect(sw).to.equal(controllerBeforeTest);
    });

    it(`waits for an update if the scriptURLs don't match`, async function() {
      const controllerBeforeTest = navigator.serviceWorker.controller;
      const scriptURL = uniq('sw-clients-claim.js.njk');
      const wb = new Workbox(scriptURL);

      // Registering using a different script URL should trigger an update,
      // and `.controlling` shouldn't resolve until after the update.
      await wb.register();
      const sw = await wb.controlling;

      expect(sw).to.equal(navigator.serviceWorker.controller);
      expect(sw).to.not.equal(controllerBeforeTest);
    });
  });

  describe(`getSW`, function() {
    it(`resolves as soon as it has a reference to the SW registered by this instance`, async function() {
      const wb = new Workbox(uniq('sw-skip-waiting-deferred.js.njk'));

      // Intentionally do not await `register()`, so we can test that
      // `getSW()` does in its implementation.
      wb.register();

      const reg = await navigator.serviceWorker.getRegistration();
      const sw = await wb.getSW();

      // This SW defers calling skip waiting, so our SW should match the
      // installing service worker.
      expect(sw).to.equal(reg.installing);
    });

    it(`resolves before updating if a SW with the same script URL is already controlling`, async function() {
      const scriptURL = navigator.serviceWorker.controller.scriptURL;
      const wb = new Workbox(scriptURL);

      // Registering using the same script URL that's already active won't
      // trigger an update.
      wb.register();

      const sw = await wb.getSW();
      expect(sw).to.equal(navigator.serviceWorker.controller);
    });

    it(`resolves before updating if a SW with the same script URL is already waiting to install`, async function() {
      const scriptURL = uniq('sw-no-skip-waiting.js.njk');

      const wb1 = new Workbox(scriptURL);
      const reg1 = await wb1.register();

      await nextEvent(wb1, 'waiting');
      expect(reg1.waiting.scriptURL).to.equal(scriptURL);

      // Stub the controlling SW's scriptURL so it matches the SW that is
      // about to be waiting. This is done to assert that if a matching
      // controller *and* waiting SW are found at registration time, the
      // `getSW()` method resolves to the waiting SW.
      sandbox.stub(navigator.serviceWorker.controller, 'scriptURL')
          .value(scriptURL);

      const wb2 = new Workbox(scriptURL);
      const reg2Promise = wb2.register();

      const sw = await wb2.getSW();
      const reg2 = await reg2Promise;
      expect(sw).to.equal(reg2.waiting);
    });

    it(`resolves as soon as an an update is found (if not already resolved)`, async function() {
      const wb = new Workbox(uniq('sw-clients-claim.js.njk'));
      wb.register();

      const sw = await wb.getSW();
      expect(sw.state).to.equal('installing');
    });

    it(`resolves to the new SW after an update is found`, async function() {
      const scriptURL = navigator.serviceWorker.controller.scriptURL;

      // Update the SW after it's controlling so both an original compatible
      // controller is found **and** and update is found. We need to assert
      // that the `getSW()` method resolves to the correct SW in both cases.
      await updateVersion('2.0.0', scriptURL);

      const wb = new Workbox(scriptURL);

      // Registering using the same script URL that's already active won't
      // trigger an update.
      const regPromise = wb.register();

      const controllingSW = await wb.getSW();
      expect(controllingSW).to.equal(navigator.serviceWorker.controller);

      const reg = await regPromise;

      // Force an update check.
      reg.update();

      await nextEvent(wb, 'controlling');

      const installedSW = await wb.getSW();
      expect(installedSW).to.equal(reg.active);
      expect(installedSW).to.not.equal(controllingSW);
    });
  });

  describe(`messageSW`, function() {
    it(`postMessages the registered service worker`, async function() {
      const wb = new Workbox(uniq('sw-message-reply.js'));
      await wb.register();

      const messageSpy = sandbox.spy();
      navigator.serviceWorker.addEventListener('message', messageSpy);

      wb.messageSW({type: 'POST_MESSAGE_BACK'});
      await waitUntil(() => messageSpy.called);

      expect(messageSpy.args[0][0].data).to.equal('postMessage from SW!');
    });

    it(`returns a promise that resolves with the SW's response (if any)`, async function() {
      const wb = new Workbox(uniq('sw-message-reply.js'));
      wb.register();

      const response = await wb.messageSW({type: 'RESPOND_TO_MESSAGE'});
      expect(response).to.equal('Reply from SW!');
    });

    it(`awaits registration if registration hasn't run`, async function() {
      const wb = new Workbox(uniq('sw-message-reply.js'));
      setTimeout(() => wb.register(), 100);

      const response = await wb.messageSW({type: 'RESPOND_TO_MESSAGE'});
      expect(response).to.equal('Reply from SW!');
    });
  });

  describe(`events`, function() {
    describe(`message`, function() {
      it(`fires when a postMessage is received from the SW`, async function() {
        const wb = new Workbox(uniq('sw-message-reply.js'));
        await wb.register();
        await wb.getSW();

        const messageSpy = sandbox.spy();
        wb.addEventListener('message', messageSpy);

        wb.messageSW({type: 'POST_MESSAGE_BACK'});
        await nextEvent(wb, 'message');

        assertMatchesWorkboxEvent(messageSpy.args[0][0], {
          type: 'message',
          target: wb,
          data: 'postMessage from SW!',
          originalEvent: {type: 'message'},
        });
      });

      it(`fires when a BroadcastChannel message for the workbox tag is received`, async function() {
        if (!('BroadcastChannel' in self)) this.skip();

        const wb = new Workbox(uniq('sw-message-reply.js'));
        await wb.register();
        await wb.getSW();

        const messageSpy = sandbox.spy();
        wb.addEventListener('message', messageSpy);

        wb.messageSW({type: 'BROADCAST_BACK'});
        await nextEvent(wb, 'message');

        assertMatchesWorkboxEvent(messageSpy.args[0][0], {
          type: 'message',
          target: wb,
          data: 'BroadcastChannel from SW!',
          originalEvent: {type: 'message'},
        });
      });
    });

    describe(`installed`, function() {
      it(`fires the first time the registered SW is installed`, async function() {
        const scriptURL = uniq('sw-clients-claim.js.njk');

        const wb1 = new Workbox(scriptURL);
        const installed1Spy = sandbox.spy();
        wb1.addEventListener('installed', installed1Spy);

        await wb1.register();
        await nextEvent(wb1, 'installed');

        // Create a second instance for the same SW script so it won't be
        // installed this time.
        const wb2 = new Workbox(scriptURL);
        const installed2Spy = sandbox.spy();
        wb2.addEventListener('installed', installed2Spy);
        await wb2.register();

        // Create a third instance for a different script to assert the
        // callback runs again, but only for own instances.
        const wb3 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const installed3Spy = sandbox.spy();
        wb3.addEventListener('installed', installed3Spy);
        await wb3.register();
        await nextEvent(wb3, 'installed');

        expect(installed1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(installed1Spy.args[0][0], {
          type: 'installed',
          target: wb1,
          sw: await wb1.getSW(),
          originalEvent: {type: 'statechange'},
          isUpdate: true,
        });

        expect(installed2Spy.callCount).to.equal(0);

        expect(installed3Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(installed3Spy.args[0][0], {
          type: 'installed',
          target: wb3,
          sw: await wb3.getSW(),
          originalEvent: {type: 'statechange'},
          isUpdate: true,
        });
      });
    });

    describe(`waiting`, function() {
      it(`runs if the registered service worker is waiting`, async function() {
        const wb1 = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        const waiting1Spy = sandbox.spy();
        wb1.addEventListener('waiting', waiting1Spy);

        const wb2 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const waiting2Spy = sandbox.spy();
        wb2.addEventListener('waiting', waiting2Spy);

        const wb3 = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        const waiting3Spy = sandbox.spy();
        wb3.addEventListener('waiting', waiting3Spy);

        await wb1.register();
        await nextEvent(wb1, 'waiting');
        await wb2.register();
        await wb3.register();
        await nextEvent(wb3, 'waiting');

        expect(waiting1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(waiting1Spy.args[0][0], {
          type: 'waiting',
          target: wb1,
          sw: await wb1.getSW(),
          originalEvent: {type: 'statechange'},
          wasWaitingBeforeRegister: undefined,
        });

        console.log(waiting2Spy.args);
        expect(waiting2Spy.callCount).to.equal(0);

        expect(waiting3Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(waiting3Spy.args[0][0], {
          type: 'waiting',
          target: wb3,
          sw: await wb3.getSW(),
          originalEvent: {type: 'statechange'},
          wasWaitingBeforeRegister: undefined,
        });
      });

      it(`runs if a service worker was already waiting at registration time`, async function() {
        const scriptURL = uniq('sw-no-skip-waiting.js.njk');

        const wb1 = new Workbox(scriptURL);
        await wb1.register();
        await nextEvent(wb1, 'waiting');

        // Register a new instance for the already waiting script.
        const wb2 = new Workbox(scriptURL);
        const waiting2Spy = sandbox.spy();
        wb2.addEventListener('waiting', waiting2Spy);
        await wb2.register();

        console.log(waiting2Spy.args);

        expect(waiting2Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(waiting2Spy.args[0][0], {
          type: 'waiting',
          target: wb2,
          sw: await wb1.getSW(),
          originalEvent: undefined,
          isUpdate: undefined,
          wasWaitingBeforeRegister: true,
        });
      });
    });

    describe(`activated`, function() {
      it(`runs the first time the registered SW is activated`, async function() {
        const wb1 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const activated1Spy = sandbox.spy();
        wb1.addEventListener('activated', activated1Spy);
        await wb1.register();
        await nextEvent(wb1, 'activated');

        const wb2 = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        const activated2Spy = sandbox.spy();
        wb2.addEventListener('activated', activated2Spy);
        await wb2.register();

        const wb3 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const activated3Spy = sandbox.spy();
        wb3.addEventListener('activated', activated3Spy);
        await wb3.register();
        await nextEvent(wb3, 'activated');

        expect(activated1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(activated1Spy.args[0][0], {
          type: 'activated',
          target: wb1,
          sw: await wb1.getSW(),
          originalEvent: {type: 'statechange'},
        });

        expect(activated2Spy.callCount).to.equal(0);

        expect(activated3Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(activated3Spy.args[0][0], {
          type: 'activated',
          target: wb3,
          sw: await wb3.getSW(),
          originalEvent: {type: 'statechange'},
        });
      });
    });

    describe(`controlling`, function() {
      it(`runs the first time the registered SW is controlling`, async function() {
        const wb1 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const controlling1Spy = sandbox.spy();
        wb1.addEventListener('controlling', controlling1Spy);
        await wb1.register();
        await nextEvent(wb1, 'controlling');

        const wb2 = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        const controlling2Spy = sandbox.spy();
        wb2.addEventListener('controlling', controlling2Spy);
        await wb2.register();

        const wb3 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const controlling3Spy = sandbox.spy();
        wb3.addEventListener('controlling', controlling3Spy);
        await wb3.register();
        await nextEvent(wb3, 'controlling');

        // NOTE(philipwalton): because these unit tests always start with a
        // controlling SW, this test doesn't really cover the case where a SW
        // is active but not yet controlling the page (which can happen
        // the first time a page registers a SW). This case is tested in the
        // integration tests.

        expect(controlling1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(controlling1Spy.args[0][0], {
          type: 'controlling',
          target: wb1,
          sw: await wb1.getSW(),
          originalEvent: {type: 'controllerchange'},
          isUpdate: true,
        });

        expect(controlling2Spy.callCount).to.equal(0);

        expect(controlling3Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(controlling3Spy.args[0][0], {
          type: 'controlling',
          target: wb3,
          sw: await wb3.getSW(),
          originalEvent: {type: 'controllerchange'},
        });
      });
    });

    describe(`redundant`, function() {
      it(`runs if the registered SW becomes redundant`, async function() {
        const wb1 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const redundantSpy = sandbox.spy();
        wb1.addEventListener('redundant', redundantSpy);

        await wb1.register();
        await wb1.controlling;

        const wb2 = new Workbox(uniq('sw-skip-waiting.js.njk'));

        await wb2.register();
        await wb2.controlling;

        expect(redundantSpy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(redundantSpy.args[0][0], {
          type: 'redundant',
          target: wb1,
          sw: await wb1.getSW(),
          originalEvent: {type: 'statechange'},
        });
      });

      it(`runs in the case where the registered SW was already controlling`, async function() {
        const controllerBeforeTest = navigator.serviceWorker.controller;
        const scriptURL = controllerBeforeTest.scriptURL;
        const wb1 = new Workbox(scriptURL);

        const redundantSpy = sandbox.spy();
        wb1.addEventListener('redundant', redundantSpy);

        await wb1.register();
        await wb1.controlling;

        const wb2 = new Workbox(uniq('sw-skip-waiting.js.njk'));

        await wb2.register();
        await wb2.controlling;

        expect(redundantSpy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(redundantSpy.args[0][0], {
          type: 'redundant',
          target: wb1,
          sw: await wb1.getSW(),
          originalEvent: {type: 'statechange'},
        });
      });
    });

    describe(`externalinstalled`, function() {
      it(`runs when an external SW is found and installed`, async function() {
        const wb1 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const externalInstalled1Spy = sandbox.spy();
        wb1.addEventListener('externalinstalled', externalInstalled1Spy);
        await wb1.register();
        await wb1.controlling;

        const wb2 = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        const externalInstalled2Spy = sandbox.spy();
        wb2.addEventListener('externalinstalled', externalInstalled2Spy);
        await wb2.register();
        await nextEvent(wb2, 'installed');

        expect(externalInstalled1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(externalInstalled1Spy.args[0][0], {
          type: 'externalinstalled',
          target: wb1,
          sw: await wb2.getSW(),
          originalEvent: {type: 'statechange'},
        });

        // Assert the same method on the second instance isn't called.
        expect(externalInstalled2Spy.callCount).to.equal(0);
      });
    });

    describe(`externalwaiting`, function() {
      it(`runs when an external SW is waiting`, async function() {
        const wb1 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const waiting1Spy = sandbox.spy();
        wb1.addEventListener('waiting', waiting1Spy);
        const externalWaiting1Spy = sandbox.spy();
        wb1.addEventListener('externalwaiting', externalWaiting1Spy);
        await wb1.register();
        await nextEvent(wb1, 'controlling');

        const wb2 = new Workbox(uniq('sw-no-skip-waiting.js.njk'));
        const waiting2Spy = sandbox.spy();
        wb2.addEventListener('waiting', waiting2Spy);
        const externalWaiting2Spy = sandbox.spy();
        wb2.addEventListener('externalwaiting', externalWaiting2Spy);
        await wb2.register();
        await nextEvent(wb2, 'waiting');

        expect(waiting1Spy.callCount).to.equal(0);
        expect(externalWaiting1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(externalWaiting1Spy.args[0][0], {
          type: 'externalwaiting',
          target: wb1,
          sw: await wb2.getSW(),
          originalEvent: {type: 'statechange'},
        });

        expect(waiting2Spy.callCount).to.equal(1);
        expect(externalWaiting2Spy.callCount).to.equal(0);
      });
    });

    describe(`externalactivated`, function() {
      it(`runs when an external SW is found and activated`, async function() {
        const wb1 = new Workbox(uniq('sw-clients-claim.js.njk'));
        const externalActivated1Spy = sandbox.spy();
        wb1.addEventListener('externalactivated', externalActivated1Spy);

        await wb1.register();
        await wb1.controlling;

        const wb2 = new Workbox(uniq('sw-skip-waiting.js.njk'));
        const externalActivated2Spy = sandbox.spy();
        wb2.addEventListener('externalactivated', externalActivated2Spy);
        await wb2.register();
        await nextEvent(wb2, 'activated');

        expect(externalActivated1Spy.callCount).to.equal(1);
        assertMatchesWorkboxEvent(externalActivated1Spy.args[0][0], {
          type: 'externalactivated',
          target: wb1,
          sw: await wb2.getSW(),
          originalEvent: {type: 'statechange'},
        });

        // Assert the same method on the second instance isn't called.
        expect(externalActivated2Spy.callCount).to.equal(0);
      });
    });

    describe(`removeEventListener()`, function() {
      it(`will register and then unregister event listeners of a given type`, function() {
        const eventType = 'testEventType';
        const event = {type: eventType};
        const eventListener1 = sandbox.stub();
        const eventListener2 = sandbox.stub();

        const wb = new Workbox(uniq('sw-clients-claim.js.njk'));
        wb.addEventListener(eventType, eventListener1);
        wb.addEventListener(eventType, eventListener2);

        wb.dispatchEvent(event);
        expect(eventListener1.calledOnceWith(event)).to.be.true;
        expect(eventListener2.calledOnceWith(event)).to.be.true;

        wb.removeEventListener(eventType, eventListener2);
        wb.dispatchEvent(event);

        // The remaining stub should be called again.
        expect(eventListener1.calledTwice).to.be.true;
        // Make sure the removed stub was called only once.
        expect(eventListener2.calledOnce).to.be.true;
      });
    });
  });
});
