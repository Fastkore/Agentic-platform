const fastkoreQuery = new URLSearchParams(location.search);
if (fastkoreQuery.get('embedded') === 'fastkore') {
  document.documentElement.dataset.fastkoreTheme = fastkoreQuery.get('theme') === 'dark' ? 'dark' : 'light';
}
