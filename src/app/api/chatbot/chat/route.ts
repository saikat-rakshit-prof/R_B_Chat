import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { customers, bills, billItems, inventory, products, productSizes, invoiceCounter } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';

const client = new Anthropic();

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

async function searchProducts(query: string) {
  try {
    const allProducts = await db.select().from(products);
    const allSizes = await db.select().from(productSizes);
    
    // Filter products by name, brand, or category
    const filtered = allProducts.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.brand.toLowerCase().includes(query.toLowerCase()) ||
      p.category.toLowerCase().includes(query.toLowerCase())
    );
    
    // Map to product with sizes
    return filtered.map(p => {
      const sizes = allSizes.filter(s => s.productId === p.id);
      return {
        id: p.id,
        name: p.name,
        brand: p.brand,
        category: p.category,
        sizes: sizes.map(s => ({
          id: s.id,
          sizeName: s.sizeName,
          pricePerBottle: parseFloat(s.pricePerBottle as string),
          pricePerCarton: parseFloat(s.pricePerCarton as string),
          bottlesPerCarton: s.bottlesPerCarton,
        })),
      };
    });
  } catch (error) {
    console.error('Error searching products:', error);
    return [];
  }
}

async function checkInventory(productSizeId: string) {
  try {
    const [inv] = await db.select().from(inventory).where(
      eq(inventory.productSizeId, productSizeId)
    );
    
    if (!inv) return { available: false, stock: 0, status: 'Out of Stock' };
    
    return {
      available: inv.currentStock > 0,
      stock: inv.currentStock,
      status: inv.status,
      lowStockThreshold: inv.lowStockThreshold,
    };
  } catch (error) {
    console.error('Error checking inventory:', error);
    return { available: false, stock: 0, status: 'Error' };
  }
}

async function createOrder(orderData: {
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  deliveryAddress: string;
  items: Array<{ productSizeId: string; quantity: number; packaging: 'bottle' | 'carton' }>;
  paymentMode: 'cash' | 'card' | 'credit' | 'upi';
  notes?: string;
}) {
  try {
    // Get or create customer
    let customerId = null;
    const existingCustomer = await db.select().from(customers).where(
      eq(customers.phone, orderData.customerPhone)
    );

    if (existingCustomer.length > 0) {
      customerId = existingCustomer[0].id;
    } else {
      const [newCustomer] = await db.insert(customers).values({
        name: orderData.customerName,
        phone: orderData.customerPhone,
        email: orderData.customerEmail || null,
        address: orderData.deliveryAddress,
        notes: `Online chat order. ${orderData.notes || ''}`,
      }).returning();
      customerId = newCustomer.id;
    }

    // Calculate bill amounts
    let subtotal = 0;
    const billItemsToInsert: any[] = [];

    // First, validate all items have stock
    for (const item of orderData.items) {
      const [sizeInfo] = await db.select().from(productSizes).where(
        eq(productSizes.id, item.productSizeId)
      );

      if (!sizeInfo) {
        return { success: false, error: `Product size not found: ${item.productSizeId}` };
      }

      const [invItem] = await db.select().from(inventory).where(
        eq(inventory.productSizeId, item.productSizeId)
      );

      if (!invItem || invItem.currentStock < item.quantity) {
        return {
          success: false,
          error: `Insufficient stock for item. Available: ${invItem?.currentStock || 0}`,
        };
      }

      const price = item.packaging === 'carton'
        ? parseFloat(sizeInfo.pricePerCarton as string)
        : parseFloat(sizeInfo.pricePerBottle as string);

      const itemTotal = price * item.quantity;
      subtotal += itemTotal;

      const [product] = await db.select().from(products).where(
        eq(products.id, sizeInfo.productId)
      );

      billItemsToInsert.push({
        productSizeId: item.productSizeId,
        productName: product.name,
        sizeName: sizeInfo.sizeName,
        packaging: item.packaging,
        quantity: item.quantity,
        unitPrice: price.toString(),
        totalPrice: itemTotal.toString(),
      });
    }

    // Generate invoice number
    const existingCounter = await db.select().from(invoiceCounter).where(eq(invoiceCounter.id, 1));
    if (existingCounter.length === 0) {
      await db.insert(invoiceCounter).values({ id: 1, lastNumber: 0 });
    }

    const [counter] = await db.update(invoiceCounter)
      .set({ lastNumber: sql`last_number + 1` })
      .where(eq(invoiceCounter.id, 1))
      .returning({ lastNumber: invoiceCounter.lastNumber });

    const currentCount = counter?.lastNumber || 1;
    const invoiceNumber = `CHT-${String(currentCount).padStart(4, '0')}`;

    // Create bill
    const totalAmount = subtotal;
    const [bill] = await db.insert(bills).values({
      invoiceNumber,
      billType: 'order',
      customerName: orderData.customerName,
      customerPhone: orderData.customerPhone,
      customerId: customerId,
      subtotal: subtotal.toString(),
      discountType: 'percentage',
      discountValue: '0',
      discountAmount: '0',
      totalAmount: totalAmount.toString(),
      paymentMode: orderData.paymentMode.charAt(0).toUpperCase() + orderData.paymentMode.slice(1),
      status: 'pending',
      outstandingAmount: totalAmount.toString(),
      deliveryDate: new Date(Date.now() + 30 * 60000), // 30 mins from now
    }).returning();

    // Insert bill items
    await db.insert(billItems).values(
      billItemsToInsert.map(item => ({ ...item, billId: bill.id }))
    );

    // Deduct inventory for each item
    for (const item of orderData.items) {
      const [invItem] = await db.select().from(inventory).where(
        eq(inventory.productSizeId, item.productSizeId)
      );

      if (invItem) {
        const newStock = invItem.currentStock - item.quantity;
        const newStatus = newStock <= 0 ? 'Out of Stock' : newStock <= (invItem.lowStockThreshold || 50) ? 'Low Stock' : 'Healthy';

        await db.update(inventory)
          .set({
            currentStock: newStock,
            status: newStatus,
            updatedAt: new Date(),
          })
          .where(eq(inventory.id, invItem.id));
      }
    }

    return {
      success: true,
      orderId: bill.id,
      invoiceNumber: bill.invoiceNumber,
      totalAmount: parseFloat(bill.totalAmount as string),
      estimatedDelivery: '30 minutes',
    };
  } catch (error) {
    console.error('Error creating order:', error);
    return { success: false, error: String(error) };
  }
}

async function getCustomerOrders(phoneNumber: string, limit = 5) {
  try {
    const [customer] = await db.select().from(customers).where(
      eq(customers.phone, phoneNumber)
    );

    if (!customer) {
      return { hasCustomer: false, orders: [] };
    }

    const customerBills = await db.select().from(bills).where(
      eq(bills.customerId, customer.id)
    ).limit(limit);

    return {
      hasCustomer: true,
      customer: {
        name: customer.name,
        phone: customer.phone,
        totalPurchases: parseFloat(customer.totalPurchases as string),
        outstandingBalance: parseFloat(customer.outstandingBalance as string),
      },
      orders: customerBills.map(b => ({
        invoiceNumber: b.invoiceNumber,
        totalAmount: parseFloat(b.totalAmount as string),
        status: b.status,
        createdAt: b.createdAt,
      })),
    };
  } catch (error) {
    console.error('Error getting customer orders:', error);
    return { hasCustomer: false, orders: [] };
  }
}

// ============================================================================
// MAIN CHATBOT HANDLER
// ============================================================================

const tools: Anthropic.Messages.Tool[] = [
  {
    name: 'search_products',
    description: 'Search for products by name, brand, or category. Use this to find what products are available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query for products (e.g., "Coca-Cola", "fanta", "cold drinks")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'check_inventory',
    description: 'Check if a product size is in stock and get current stock level',
    input_schema: {
      type: 'object' as const,
      properties: {
        product_size_id: {
          type: 'string',
          description: 'The ID of the product size to check inventory for',
        },
      },
      required: ['product_size_id'],
    },
  },
  {
    name: 'create_order',
    description: 'Create a new order with customer details and items. Use this after customer confirms their order.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customerName: {
          type: 'string',
          description: 'Customer full name',
        },
        customerPhone: {
          type: 'string',
          description: 'Customer phone number (10 digits for India)',
        },
        customerEmail: {
          type: 'string',
          description: 'Customer email (optional)',
        },
        deliveryAddress: {
          type: 'string',
          description: 'Delivery address for the order',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productSizeId: {
                type: 'string',
                description: 'Product size ID',
              },
              quantity: {
                type: 'number',
                description: 'Quantity to order',
              },
              packaging: {
                type: 'string',
                enum: ['bottle', 'carton'],
                description: 'Packaging type',
              },
            },
            required: ['productSizeId', 'quantity', 'packaging'],
          },
          description: 'Array of items to order',
        },
        paymentMode: {
          type: 'string',
          enum: ['cash', 'card', 'credit', 'upi'],
          description: 'Payment mode',
        },
        notes: {
          type: 'string',
          description: 'Additional notes or special instructions',
        },
      },
      required: ['customerName', 'customerPhone', 'deliveryAddress', 'items', 'paymentMode'],
    },
  },
  {
    name: 'get_customer_orders',
    description: 'Get past orders and customer information for a phone number',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone_number: {
          type: 'string',
          description: 'Customer phone number',
        },
      },
      required: ['phone_number'],
    },
  },
];

async function processToolCall(toolName: string, toolInput: any): Promise<string> {
  try {
    switch (toolName) {
      case 'search_products': {
        const results = await searchProducts(toolInput.query);
        return JSON.stringify(results);
      }
      case 'check_inventory': {
        const result = await checkInventory(toolInput.product_size_id);
        return JSON.stringify(result);
      }
      case 'create_order': {
        const result = await createOrder(toolInput);
        return JSON.stringify(result);
      }
      case 'get_customer_orders': {
        const result = await getCustomerOrders(toolInput.phone_number);
        return JSON.stringify(result);
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (error) {
    return JSON.stringify({ error: String(error) });
  }
}

export async function POST(request: Request) {
  try {
    const { messages, conversationId } = await request.json();

    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      );
    }

    console.log('🤖 Chatbot request:', { conversationId, messageCount: messages.length });

    // System prompt for the chatbot
    const systemPrompt = `You are a friendly and helpful customer service chatbot for FrostyFlow, a cold drinks delivery service. Your job is to help customers order beverages online.

Guidelines:
- Be warm, casual, and conversational
- Always use relevant emojis to make it engaging
- Help customers browse products, check availability, and place orders
- Confirm all order details before creating the order
- If a product is out of stock, suggest alternatives
- Be clear about delivery time (estimated 30 mins) and payment options
- Always ask for customer name and phone number for new customers
- Confirm delivery address clearly
- Be helpful about past orders if they are returning customers
- For payment modes, support: Cash, Card, Credit, UPI

When customer wants to order:
1. Help them search and select products
2. Check inventory for their choices
3. Confirm quantities and preferences (bottle vs carton)
4. Get their delivery address and contact info
5. Confirm payment method
6. Create the order using the create_order tool
7. Provide order confirmation with order ID

Always be accurate about pricing and availability. If something goes wrong, apologize and offer alternatives.`;

    let response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools,
      messages: messages.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
      })),
    });

    console.log('🤖 Claude response - stop_reason:', response.stop_reason);

    // Handle tool use in a loop
    while (response.stop_reason === 'tool_use') {
      const toolUseBlock = response.content.find(
        (block: any) => block.type === 'tool_use'
      ) as any;

      if (!toolUseBlock) break;

      const toolName = toolUseBlock.name;
      const toolInput = toolUseBlock.input;

      console.log(`🛠️  Tool call: ${toolName}`, toolInput);

      const toolResult = await processToolCall(toolName, toolInput);

      console.log(`✅ Tool result:`, toolResult);

      // Continue conversation with tool result
      response = await client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        system: systemPrompt,
        tools: tools,
        messages: [
          ...messages.map((msg: any) => ({
            role: msg.role,
            content: msg.content,
          })),
          {
            role: 'assistant',
            content: response.content,
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: toolResult,
              },
            ],
          },
        ],
      });
    }

    // Extract final text response
    const textBlock = response.content.find((block: any) => block.type === 'text') as any;
    const finalResponse = textBlock?.text || 'I encountered an issue. Please try again.';

    return NextResponse.json({
      response: finalResponse,
      conversationId: conversationId || `conv-${Date.now()}`,
    });
  } catch (error) {
    console.error('❌ Chatbot error:', error);
    return NextResponse.json(
      { error: 'Failed to process chat message', details: String(error) },
      { status: 500 }
    );
  }
}
