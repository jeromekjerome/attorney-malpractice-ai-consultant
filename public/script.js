document.addEventListener('DOMContentLoaded', () => {
    const askForm = document.getElementById('askForm');
    const questionInput = document.getElementById('questionInput');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const spinner = document.getElementById('spinner');

    const resultsWrapper = document.getElementById('resultsWrapper');
    const answerText = document.getElementById('answerText');
    const sourcesList = document.getElementById('sourcesList');

    const modeToggle = document.getElementById('modeToggle');
    const labelClient = document.getElementById('label-client');
    const labelProfessor = document.getElementById('label-professor');

    let currentMode = 'client';

    // Handle Mode Switch
    modeToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            currentMode = 'professor';
            document.body.classList.add('professor-mode');
            labelProfessor.classList.add('active');
            labelClient.classList.remove('active');
            questionInput.placeholder = "e.g., Professor, how does the continuous representation doctrine apply if...";
            submitBtn.querySelector('.btn-text').textContent = "Submit to Professor";
        } else {
            currentMode = 'client';
            document.body.classList.remove('professor-mode');
            labelClient.classList.add('active');
            labelProfessor.classList.remove('active');
            questionInput.placeholder = "e.g., What happens if my lawyer misses the statute of limitations in New York?";
            submitBtn.querySelector('.btn-text').textContent = "Analyze Case";
        }
    });

    // Auto-resize textarea
    questionInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    askForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const question = questionInput.value.trim();
        if (!question) return;

        // UI Loading State
        setLoading(true);

        try {
            const response = await fetch('/api/ask', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ question, mode: currentMode })
            });

            if (!response.ok) {
                throw new Error('Network response was not ok');
            }

            const data = await response.json();

            // Format answer using Marked.js if available, otherwise just text
            if (typeof marked !== 'undefined') {
                answerText.innerHTML = marked.parse(data.answer);
            } else {
                answerText.innerText = data.answer;
            }

            // Render Sources
            sourcesList.innerHTML = '';

            // Remove duplicates from sources
            const uniqueUrls = new Set();
            data.sources.forEach(src => {
                if (!uniqueUrls.has(src.post_url)) {
                    uniqueUrls.add(src.post_url);

                    const li = document.createElement('li');
                    li.className = 'source-item';

                    const a = document.createElement('a');
                    a.href = src.post_url;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.className = 'source-link';

                    // Cleanup URL for display (remove https://, trailing slash)
                    let cleanUrl = src.post_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
                    if (cleanUrl.length > 50) {
                        cleanUrl = cleanUrl.substring(0, 47) + '...';
                    }

                    a.textContent = cleanUrl;
                    li.appendChild(a);
                    sourcesList.appendChild(li);
                }
            });

            // Reveal Results
            resultsWrapper.classList.remove('hidden');

            // Smooth scroll to results
            setTimeout(() => {
                resultsWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);

        } catch (error) {
            console.error('Error:', error);
            answerText.innerHTML = `<div style="color: #ff6b6b; font-weight: 500;">An error occurred while analyzing your case. Please try again later.</div>`;
            sourcesList.innerHTML = '';
            resultsWrapper.classList.remove('hidden');
        } finally {
            setLoading(false);
        }
    });

    function setLoading(isLoading) {
        if (isLoading) {
            btnText.style.display = 'none';
            spinner.classList.remove('hidden');
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.8';
        } else {
            btnText.style.display = 'block';
            spinner.classList.add('hidden');
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
        }
    }
});
