// Auto refresh status untuk transaksi pending
function checkPendingTransactions() {
    const pendingItems = document.querySelectorAll('[data-status="pending"]');
    
    pendingItems.forEach(item => {
        const reffId = item.getAttribute('data-reff-id');
        const apiKey = document.querySelector('#apiKey') ? document.querySelector('#apiKey').value : '';
        
        if (reffId && apiKey) {
            fetch(`/h2h/deposit/poll?apikey=${apiKey}&reff_id=${reffId}`)
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'success') {
                        // Update UI
                        item.innerHTML = '<span class="badge bg-success">Success</span>';
                        item.setAttribute('data-status', 'success');
                        
                        // Refresh balance
                        setTimeout(() => {
                            location.reload();
                        }, 2000);
                    }
                })
                .catch(error => console.error('Polling error:', error));
        }
    });
}

// Cek status transaksi setiap 10 detik
if (document.querySelectorAll('[data-status="pending"]').length > 0) {
    setInterval(checkPendingTransactions, 10000);
}

// Copy API Key to clipboard
function copyApiKey(apiKey) {
    navigator.clipboard.writeText(apiKey).then(() => {
        alert('API Key copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
}

// Format Rupiah
function formatRupiah(amount) {
    return 'Rp ' + amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Auto format input nominal
document.querySelectorAll('input[name="nominal"]').forEach(input => {
    input.addEventListener('input', function(e) {
        let value = e.target.value.replace(/\D/g, '');
        e.target.value = formatRupiah(value);
    });
});

// Confirm delete user
function confirmDelete(userId, username) {
    if (confirm(`Are you sure you want to delete user "${username}"? This action cannot be undone!`)) {
        document.getElementById(`delete-form-${userId}`).submit();
    }
}
