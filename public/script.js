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
    let conversationHistory = [];

    // Handle Mode Switch
    modeToggle.addEventListener('change', (e) => {
        if (e.target.checked) {
            currentMode = 'professor';
            document.body.classList.add('professor-mode');
            labelProfessor.classList.add('active');
            labelClient.classList.remove('active');
            conversationHistory = [];
            answerText.innerHTML = '';
            resultsWrapper.classList.add('hidden');
            questionInput.placeholder = "e.g., Professor, how does the continuous representation doctrine apply if...";
            submitBtn.querySelector('.btn-text').textContent = "Submit to Professor";
        } else {
            currentMode = 'client';
            document.body.classList.remove('professor-mode');
            labelClient.classList.add('active');
            labelProfessor.classList.remove('active');
            conversationHistory = [];
            answerText.innerHTML = '';
            resultsWrapper.classList.add('hidden');
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

        // Add to history
        conversationHistory.push({ role: 'user', content: question });

        // Update UI immediately with user message
        if (conversationHistory.length === 1) {
            answerText.innerHTML = '';
        }

        const userBubble = document.createElement('div');
        userBubble.style.margin = "1rem 0";
        userBubble.style.padding = "1rem";
        userBubble.style.background = "rgba(255,255,255,0.05)";
        userBubble.style.borderLeft = "4px solid var(--text-secondary)";
        userBubble.style.borderRadius = "var(--radius-sm)";
        userBubble.innerHTML = `<strong>You:</strong><br/>${question}`;
        answerText.appendChild(userBubble);

        // Clear input and reveal results
        questionInput.value = '';
        questionInput.style.height = 'auto';
        resultsWrapper.classList.remove('hidden');

        // UI Loading State
        setLoading(true);

        try {
            const response = await fetch('/api/ask', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ messages: conversationHistory, mode: currentMode })
            });

            if (!response.ok) {
                throw new Error('Network response was not ok');
            }

            const data = await response.json();

            // Add AI response to history
            conversationHistory.push({ role: 'assistant', content: data.answer });

            // Create AI Bubble
            const aiBubble = document.createElement('div');
            aiBubble.style.marginTop = "1.5rem";
            aiBubble.style.marginBottom = "1.5rem";
            aiBubble.innerHTML = typeof marked !== 'undefined' ? marked.parse(data.answer) : data.answer;
            answerText.appendChild(aiBubble);

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
            const errBubble = document.createElement('div');
            errBubble.style.color = "#ff6b6b";
            errBubble.style.fontWeight = "500";
            errBubble.innerText = "An error occurred while analyzing your case. Please try again later.";
            answerText.appendChild(errBubble);
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
