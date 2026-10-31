// Teste automatizado: verifica que o href final dos links de checkout começa com o código certo
// Uso: carregue a landing page, cole no console e execute
(function() {
  var links = document.querySelectorAll('a[data-checkout]');
  var failures = [];
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href') || '';
    if (href.indexOf('https://pay.hotmart.com/O108186457I') !== 0) {
      failures.push('Link ' + i + ': href=' + href.substring(0, 100));
    }
    if (href.indexOf('off=xmpilkt4') === -1) {
      failures.push('Link ' + i + ': falta off=xmpilkt4 em ' + href.substring(0, 80));
    }
    if (href.indexOf('sck=') === -1) {
      failures.push('Link ' + i + ': falta sck= em ' + href.substring(0, 80));
    }
  }
  if (failures.length === 0) {
    console.log('✅ TESTE PASSOU: todos os ' + links.length + ' links de checkout estão corretos');
  } else {
    console.log('❌ TESTE FALHOU: ' + failures.length + ' problemas');
    failures.forEach(function(f) { console.log('  ' + f); });
  }
  return failures.length;
})();
