const button = document.getElementById('open-project');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Choose your project folder…';
  try {
    await window.davecodeDesktop.chooseProject();
  } catch {
    status.textContent = 'Could not open the project. Please try again.';
  } finally {
    button.disabled = false;
    if (status.textContent === 'Choose your project folder…')
      status.textContent = 'You can also press Ctrl+O.';
  }
});
