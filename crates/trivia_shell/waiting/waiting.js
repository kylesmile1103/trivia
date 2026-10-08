// The shell passes the URL it waits for as ?target= (src/main.rs, waiting_page).
const target = new URLSearchParams(location.search).get('target')
if (target) document.getElementById('target').textContent = target
