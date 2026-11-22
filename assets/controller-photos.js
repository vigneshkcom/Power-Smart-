(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PSControllerPhotos = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function entries(items) {
    var item = (items || []).find(function (entry) { return entry.code === 'controller'; });
    if (!item) return [];
    var photos = Array.isArray(item.photos) ? item.photos : [];
    item.photos = photos.slice(0, item.qty);
    while (item.photos.length < item.qty) {
      item.photos.push({ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), photo: '' });
    }
    return item.photos;
  }
  function ready(items) {
    return entries(items).every(function (photo) { return Boolean(photo.photo || photo.photoKey); });
  }
  function attach(items, queued, path) {
    var entry = entries(items).find(function (photo) {
      return (queued.unitId && photo.id === queued.unitId) || (photo.photoKey && photo.photoKey === queued.key);
    });
    if (entry) { entry.photo = path; delete entry.photoKey; }
    return Boolean(entry);
  }
  return { entries: entries, ready: ready, attach: attach };
});
