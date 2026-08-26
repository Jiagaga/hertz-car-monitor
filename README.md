# Hertz El Calafate Airport Inventory Monitor

Monitors Hertz for:

- Pickup: El Calafate Airport (FTE), 2026-09-27 17:00
- Return: El Calafate Airport (FTE), 2026-10-04 17:00
- Check interval: every 15 minutes
- Notification: Bark, only when a vehicle is newly detected

The monitor uses Playwright to interact with the public Hertz reservation page as a guest. It does not require a Hertz account or Hertz API key.

## GitHub Secret

Add a repository secret named `BARK_KEY` containing the Bark key only, not the full Bark URL.

## First run

The first successful run records the current inventory as the baseline and does not send a notification. Later runs compare against that baseline and send Bark when a new vehicle appears.
