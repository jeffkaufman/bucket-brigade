addEventListener('error', (event) => {
  event.preventDefault();
  let {name, message, stack, unpreventable} = event.error ?? {};
  [name, message, stack] = [name, message, stack].map(String);
  unpreventable = Boolean(unpreventable);
  postMessage({
    type: "exception",
    exception: {name, message, stack, unpreventable},
  });
});
addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  throw event.reason;
});
importScripts('opusjs/encoder.js')
