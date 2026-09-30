# Retail Billing System with AI Chatbot

Point of Sale & Inventory Management System with AI-powered customer ordering chatbot.

## Tech Stack
- Next.js 16
- React 19
- Tailwind CSS 4
- Drizzle ORM
- Neon PostgreSQL Database
- Zustand State Management
- Claude AI (Anthropic)

## Features

### Admin/POS Features
✅ Sales POS interface with cart management
✅ Inventory tracking & stock management
✅ Sales reports & analytics charts
✅ Product categories & items management
✅ PDF invoice generation
✅ Customer management & credit tracking
✅ Responsive mobile & desktop UI
✅ Keyboard shortcuts support

### Customer Chatbot Features
✅ AI-powered product search
✅ Real-time inventory checking
✅ Natural language order placement
✅ Order history & customer recognition
✅ Payment mode selection
✅ Delivery address collection
✅ Order confirmation & tracking
✅ Multi-turn conversations

## Local Development

```bash
# Install dependencies
npm install

# Setup database
cp .env.example .env
# Add your Neon database URL and Anthropic API key to .env

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

Create a `.env` file with:
```
DATABASE_URL=your_neon_database_url
ANTHROPIC_API_KEY=your_anthropic_api_key
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## Database Commands
```bash
npm run db:generate  # Generate new migrations
npm run db:push      # Push schema changes directly
npm run db:migrate   # Run migrations
npm run db:studio    # Open Drizzle Studio
```

## Build
```bash
npm run build
npm run start
```

## Deployment

This project is optimized for deployment on **Vercel**. Connect your GitHub repository on Vercel and add your `DATABASE_URL` and `ANTHROPIC_API_KEY` environment variables.

## API Endpoints

### Chatbot
- `POST /api/chatbot/chat` - Chat with AI for ordering

### Billing
- `GET /api/bills` - Get all bills
- `POST /api/bills` - Create new bill
- `GET /api/bills/[id]` - Get bill details

### Customers
- `GET /api/customers` - Get all customers
- `POST /api/customers` - Create new customer
- `GET /api/customers/[id]` - Get customer details

### Inventory
- `GET /api/inventory` - Get all inventory
- `POST /api/inventory` - Create inventory item

### Products
- `GET /api/products` - Get all products
- `POST /api/products` - Create new product
