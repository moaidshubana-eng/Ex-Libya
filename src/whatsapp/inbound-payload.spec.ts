import { extractInboundTextMessages } from './inbound-payload';

function buildPayload(messages: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ value: { messages }, field: 'messages' }] }],
  };
}

describe('extractInboundTextMessages', () => {
  it('يستخرج رسالة نصية واحدة بشكلها الصحيح', () => {
    const payload = buildPayload([
      { from: '218911234567', id: 'wamid.1', type: 'text', text: { body: 'السعر' } },
    ]);

    expect(extractInboundTextMessages(payload)).toEqual([
      { from: '218911234567', text: 'السعر', waMessageId: 'wamid.1' },
    ]);
  });

  it('يتجاهل تحديثات حالة التسليم (statuses) وأنواع الوسائط الأخرى', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            { value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] }, field: 'messages' },
            {
              value: { messages: [{ from: '218900000000', id: 'wamid.2', type: 'image' }] },
              field: 'messages',
            },
          ],
        },
      ],
    };

    expect(extractInboundTextMessages(payload)).toEqual([]);
  });

  it('لا يرمي استثناء على حمولة غير متوقعة الشكل', () => {
    expect(extractInboundTextMessages({})).toEqual([]);
    expect(extractInboundTextMessages(null)).toEqual([]);
    expect(extractInboundTextMessages({ entry: 'not-an-array' })).toEqual([]);
  });
});
