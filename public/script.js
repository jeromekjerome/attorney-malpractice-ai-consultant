document.addEventListener('DOMContentLoaded', () => {
    const askForm = document.getElementById('askForm');
    const questionInput = document.getElementById('questionInput');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const spinner = document.getElementById('spinner');
    const questionLabel = document.getElementById('questionLabel');

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
            questionLabel.textContent = "Describe your situation or legal question";
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
            questionLabel.textContent = "Describe your situation or legal question";
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
            questionInput.placeholder = "Type your response or provide more details...";
            submitBtn.querySelector('.btn-text').textContent = "Reply";
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

        // Immediately scroll down so the user sees the reasoning bubble and input box
        setTimeout(() => {
            askForm.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }, 100);

        // UI Loading State
        setLoading(true);

        // Reasoning Messages UI
        const thinkingBubble = document.createElement('div');
        thinkingBubble.className = "thinking-bubble";
        thinkingBubble.style.margin = "1.5rem 0";
        thinkingBubble.style.padding = "1rem";
        thinkingBubble.style.background = "rgba(138, 43, 226, 0.05)";
        thinkingBubble.style.borderLeft = "4px solid #8a2be2";
        thinkingBubble.style.borderRadius = "var(--radius-sm)";
        thinkingBubble.style.color = "var(--text-secondary)";
        thinkingBubble.style.display = "flex";
        thinkingBubble.style.alignItems = "center";
        thinkingBubble.style.gap = "12px";

        // Use inline SVG for a nice spinner
        thinkingBubble.innerHTML = `
            <svg class="internal-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
            <span class="thinking-text" style="font-style: italic;"></span>
            <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>
        `;

        const reasoningMessages = [
            "Searching Andrew's Archive...",
            "Synthesizing NY Case Law...",
            "Evaluating Malpractice Precedents...",
            "Formulating Legal Inference...",
            "Verifying Citations via CourtListener...",
            "Running Forward Citation Analysis...",
            "Checking for Superseding Precedents...",
            "Profiling Recent Case Developments..."
        ];

        let reasoningIndex = 0;
        const thinkingTextSpan = thinkingBubble.querySelector('.thinking-text');
        thinkingTextSpan.innerText = reasoningMessages[0];
        answerText.appendChild(thinkingBubble);

        const reasoningInterval = setInterval(() => {
            reasoningIndex++;
            thinkingTextSpan.innerText = reasoningMessages[reasoningIndex % reasoningMessages.length];
        }, 1800);

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
            conversationHistory.push({ role: 'assistant', content: data.raw_answer || data.answer });

            // Create AI Bubble
            const aiBubble = document.createElement('div');
            aiBubble.style.marginTop = "1.5rem";
            aiBubble.style.marginBottom = "1.5rem";
            aiBubble.innerHTML = typeof marked !== 'undefined' ? marked.parse(data.answer) : data.answer;
            answerText.appendChild(aiBubble);

            // Update Label with AI's last question, if any
            const questions = data.answer.match(/[^.?!]+(\?)/g);
            if (questions && questions.length > 0) {
                let lastQ = questions[questions.length - 1].trim();
                // Strip common markdown markers at the beginning
                lastQ = lastQ.replace(/^[\s\n>*]+/, '');
                questionLabel.textContent = lastQ;
            } else {
                questionLabel.textContent = "Describe your situation or legal question";
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
                    // Deriving a readable title first since we need titleSlug to fallback for search query
                    const segments = src.post_url.replace(/\/$/, '').split('/');
                    // Walk backwards to find the first non-date, non-empty segment
                    let titleSlug = '';
                    for (let i = segments.length - 1; i >= 0; i--) {
                        if (segments[i] && !/^\d+$/.test(segments[i])) {
                            titleSlug = segments[i];
                            break;
                        }
                    }
                    let finalTitle = titleSlug
                        ? titleSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                        : src.post_url;
                    
                    a.href = src.post_url;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.className = 'source-link';

                    a.textContent = finalTitle;

                    li.appendChild(a);
                    sourcesList.appendChild(li);
                }
            });

            // Update generic UI state
            resultsWrapper.classList.remove('hidden');

            // Scroll down again to keep the input box visible after the long answer renders
            setTimeout(() => {
                askForm.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
            clearInterval(reasoningInterval);
            if (thinkingBubble && thinkingBubble.parentNode) {
                thinkingBubble.parentNode.removeChild(thinkingBubble);
            }
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
