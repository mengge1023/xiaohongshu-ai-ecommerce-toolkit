import unittest
from parse_price_block import parse

URL = 'https://xhslink.com/m/example'


def doc(price='29.8', reference='88.8', sales='6155', label='到手价'):
    return f'**标题**: 商品详情\n\n¥\n\n{price}\n\n{label}¥{reference}\n\n已售{sales}\n\n商品名称\n\n粉丝数5782已售1.8万'


class HeaderParsing(unittest.TestCase):
    def test_observed_headers(self):
        for price, ref, sales, label in [
            ('29.8','88.8','6155','到手价'), ('191','199','2889','券后价'),
            ('249','349','7809','到手价'), ('199','299','5721','券后价'),
            ('69.9','89.9','2033','券后价'),
        ]:
            with self.subTest(price=price):
                r=parse({'text':doc(price,ref,sales,label),'source_url':URL})
                self.assertTrue(r['matched']);self.assertEqual(r['sale_price'],float(price))
                self.assertEqual(r['sales_total'],int(sales))
    def test_shop_only_is_not_product_sales(self):
        r=parse({'text':doc().replace('已售6155','店铺已售6155'),'source_url':URL})
        self.assertFalse(r['matched']);self.assertIsNone(r['sales_total'])
    def test_approximate_sales_remain_unknown(self):
        for sales in ['1.2万','3000+','3千','2.5']:
            r=parse({'text':doc(sales=sales),'source_url':URL})
            self.assertTrue(r['matched']);self.assertIsNone(r['sales_total'])
            self.assertEqual(r['sales_raw'],sales)
    def test_unrecognized_format_not_guessed(self):
        for text in ['请登录','¥19.9 ¥29.9 已售300',doc().replace('到手价','会员价'), '其他文字\n'+doc()]:
            r=parse({'text':text,'source_url':URL});self.assertFalse(r['matched'])
    def test_no_zero_price_or_reversed_reference(self):
        for price in ['0','90']:
            self.assertFalse(parse({'text':doc(price=price),'source_url':URL})['matched'])
    def test_access_parameters_redacted(self):
        r=parse({'text':doc(),'source_url':URL+'?xsec_token=secret#private'})
        self.assertEqual(r['source_url'],URL)
    def test_non_xhs_source_rejected(self):
        self.assertFalse(parse({'text':doc(),'source_url':'https://example.com'})['matched'])
    def test_missing_input_not_invented(self):
        with self.assertRaises(ValueError):parse({'source_url':URL})


if __name__ == '__main__':unittest.main()
