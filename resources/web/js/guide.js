(() => {
  'use strict';

  const root = document.documentElement;
  const guideId = root.dataset.guideId || 'guide';
  const themeStorageKey = `${guideId}:theme`;
  const requestedTheme = new URLSearchParams(window.location.search).get('theme');

  const readStoredValue = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const writeStoredValue = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage can be unavailable when a guide is opened directly from disk.
    }
  };

  const storedTheme = readStoredValue(themeStorageKey);
  root.dataset.theme = requestedTheme === 'light' || requestedTheme === 'dark'
    ? requestedTheme
    : storedTheme === 'light' || storedTheme === 'dark'
      ? storedTheme
      : 'light';

  const pages = Array.from(document.querySelectorAll('.page'));
  const previousButton = document.querySelector('[data-guide-previous]');
  const nextButton = document.querySelector('[data-guide-next]');
  const pageCount = document.querySelector('[data-guide-page-count]');
  const progress = document.querySelector('[data-guide-progress]');
  const progressLabel = document.querySelector('[data-guide-progress-label]');
  const completionStatus = document.querySelector('[data-guide-completion-status]');
  const footer = document.querySelector('[data-guide-footer]');
  const themeToggle = document.querySelector('[data-theme-toggle]');
  let currentPage = 0;
  let finished = false;

  const updateThemeToggle = () => {
    if (!themeToggle) return;
    const isDark = root.dataset.theme === 'dark';
    const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
    themeToggle.setAttribute('aria-label', label);
    themeToggle.setAttribute('title', label);
    themeToggle.setAttribute('aria-pressed', String(isDark));
  };

  themeToggle?.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    writeStoredValue(themeStorageKey, root.dataset.theme);
    updateThemeToggle();
  });

  updateThemeToggle();

  const updateFooterSpace = () => {
    if (!footer) return;
    root.style.setProperty('--footer-space', `${footer.getBoundingClientRect().height / 16}rem`);
  };

  const showPage = (index) => {
    if (!pages.length) return;

    currentPage = Math.max(0, Math.min(index, pages.length - 1));
    pages.forEach((page, pageIndex) => {
      const isActive = pageIndex === currentPage;
      page.hidden = !isActive;
      page.setAttribute('aria-hidden', String(!isActive));
      page.classList.toggle('active', isActive);
    });

    const position = currentPage + 1;
    if (pageCount) pageCount.textContent = `${position} of ${pages.length}`;
    if (progress) {
      progress.max = pages.length;
      progress.value = position;
      progress.textContent = `${position} of ${pages.length}`;
    }
    if (progressLabel) progressLabel.textContent = `Page ${position} of ${pages.length}`;
    if (previousButton) previousButton.disabled = currentPage === 0;
    if (nextButton) {
      const isLastPage = currentPage === pages.length - 1;
      nextButton.textContent = isLastPage ? (finished ? 'Finished' : 'Finish') : 'Next';
      nextButton.disabled = finished && isLastPage;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    pages[currentPage].querySelector('h1, h2')?.focus({ preventScroll: true });
    updateFooterSpace();
  };

  previousButton?.addEventListener('click', () => showPage(currentPage - 1));
  nextButton?.addEventListener('click', () => {
    if (currentPage < pages.length - 1) {
      showPage(currentPage + 1);
      return;
    }

    finished = true;
    if (completionStatus) {
      completionStatus.textContent = 'Guide finished. Your progress is saved in this browser.';
    }
    nextButton.textContent = 'Finished';
    nextButton.disabled = true;
  });

  const copyText = async (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    const copied = document.execCommand('copy');
    fallback.remove();
    if (!copied) throw new Error('Copy command failed');
  };

  document.querySelectorAll('.copy-control').forEach((button) => {
    button.addEventListener('click', async () => {
      const block = button.closest('.copy-block');
      const status = button.querySelector('.copy-status');
      const text = block?.querySelector('code')?.textContent;
      if (!text) return;

      try {
        await copyText(text);
        if (status) status.textContent = 'Copied';
      } catch {
        if (status) status.textContent = 'Select text';
      }
      window.setTimeout(() => {
        if (status) status.textContent = '';
      }, 1800);
    });
  });

  document.querySelectorAll('[data-task]').forEach((checkbox) => {
    const key = `${guideId}:task:${checkbox.dataset.task}`;
    checkbox.checked = readStoredValue(key) === 'true';
    checkbox.addEventListener('change', () => writeStoredValue(key, String(checkbox.checked)));
  });

  document.querySelectorAll('form[data-quiz-answer]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const feedback = form.querySelector('.feedback');
      const selected = new FormData(form).get(form.dataset.quizName || 'answer');
      if (!feedback) return;

      if (!selected) {
        feedback.textContent = form.dataset.quizEmpty || 'Choose an answer, then try again.';
        feedback.className = 'feedback incorrect';
      } else if (selected === form.dataset.quizAnswer) {
        feedback.textContent = form.dataset.quizCorrect || 'Correct.';
        feedback.className = 'feedback correct';
      } else {
        feedback.textContent = form.dataset.quizIncorrect || 'Not quite. Review the guide and try again.';
        feedback.className = 'feedback incorrect';
      }
    });
  });

  if (footer && 'ResizeObserver' in window) {
    new ResizeObserver(updateFooterSpace).observe(footer);
  } else if (footer) {
    window.addEventListener('resize', updateFooterSpace);
  }

  showPage(0);
})();