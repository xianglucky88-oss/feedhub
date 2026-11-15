export function fanout(items, subscribers, deliver) {
  let delivered = 0;
  for (const item of items) {
    for (const subscriber of subscribers) {
      deliver(item, subscriber);
      delivered += 1;
    }
  }
  return delivered;
}
